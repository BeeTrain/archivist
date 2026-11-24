import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, utimes } from "node:fs/promises";
import { join } from "node:path";
import { analyzeSegment } from "../../analyzer/pipeline.js";
import { computeSignals, isTrivial } from "../../analyzer/signals.js";
import { nodeIo } from "../../cli/node-io.js";
import { safeText } from "../../core/capture.js";
import { loadConfig, type Config } from "../../core/config.js";
import type { Io, Llm } from "../../core/io.js";
import { withLock } from "../../core/lock.js";
import { emptyUsage, weightedTokens, type Segment, type ToolEvent } from "../../core/types.js";
import { agyLlm } from "./llm.js";

export const BASE = ".archivist/.local/antigravity";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

export interface Task {
  segment: Segment;
  revision: number;
  due: number | null;
  attempts: number;
  state: "collecting" | "pending" | "analysing" | "done" | "failed" | "postponed";
  message: string;
  lastStop?: string;
  updatedAt: number;
}

const taskPath = (session: string): string => `${BASE}/tasks/${session}.json`;

const readTask = async (io: Io, session: string): Promise<Task | undefined> => {
  const text = await io.read(taskPath(session));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Task;
  } catch {
    return undefined;
  }
};

const atomic = async (io: Io, path: string, value: unknown): Promise<void> => {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await io.write(tmp, JSON.stringify(value) + "\n");
  await rename(join(io.root, tmp), join(io.root, path));
};

export const taskTool = (input: Record<string, unknown>, config: Config, root: string): ToolEvent[] => {
  const toolCall = input.toolCall && typeof input.toolCall === "object" ? (input.toolCall as Record<string, unknown>) : {};
  const name = String(toolCall.name ?? "");
  const args = toolCall.args && typeof toolCall.args === "object" ? (toolCall.args as Record<string, unknown>) : {};
  const clean = (s: unknown) => safeText(s, config.privacy.excludePaths, root, 400);

  const rawTarget =
    args.CommandLine ??
    args.command ??
    args.Path ??
    args.TargetFile ??
    args.AbsolutePath ??
    args.SearchDirectory ??
    args.Query ??
    args.path ??
    args.file_path;
  const target = clean(rawTarget);

  const tool =
    /^run_command$|^Bash$/.test(name)
      ? "Bash"
      : /^(?:read_file|view_file|find_by_name|grep_search|list_dir)$/.test(name)
        ? "Read"
        : /^(?:write_file|edit_file|replace_file_content|multi_replace_file_content|write_to_file)$/.test(name)
          ? "Edit"
          : name.slice(0, 100) || "Tool";

  const errorRaw = typeof input.error === "string" && input.error.trim() ? input.error : "";
  const ok = !errorRaw;
  const error = !ok ? clean(errorRaw) : "";
  return [{ tool, ...(target ? { target } : {}), ok, ...(error ? { error } : {}) }];
};

const extractLastAssistantReply = async (transcriptPath: unknown, config: Config, root: string): Promise<string> => {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return "";
  try {
    const raw = await readFile(transcriptPath, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(-40).reverse();
    for (const line of lines) {
      try {
        const step = JSON.parse(line) as Record<string, unknown>;
        if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) {
          return safeText(step.content, config.privacy.excludePaths, root, 800);
        }
      } catch {}
    }
  } catch {}
  return "";
};

export const captureTask = async (
  io: Io,
  input: Record<string, unknown>,
  config: Config,
  now = Date.now(),
): Promise<void> => {
  const event = String(input.hookEventName ?? "");
  const convId = typeof input.conversationId === "string" ? input.conversationId : "";
  if (!convId || !["PreInvocation", "PostToolUse", "PostInvocation", "Stop"].includes(event)) return;
  const session = hash(convId);

  const assistantReply = event === "Stop" ? await extractLastAssistantReply(input.transcriptPath, config, io.root) : "";

  await withLock(io, async () => {
    let task = await readTask(io, session);
    const clean = (value: unknown) => safeText(value, config.privacy.excludePaths, io.root);
    const promptText = clean(input.lastUserInput);

    if (!task || task.state === "done" || task.state === "failed") {
      if (event !== "PreInvocation" && event !== "PostToolUse") return;
      task = {
        segment: {
          id: hash(`${session}:${input.invocationNum ?? now}`),
          session,
          startedAt: now,
          prompts: promptText ? [promptText] : [],
          answers: [],
          turns: [],
          tools: [],
          rulesLoaded: [],
        },
        revision: 0,
        due: null,
        attempts: 0,
        state: "collecting",
        message: "Сбор контекста",
        updatedAt: now,
      };
    }

    const turnKey = hash(String(input.executionNum ?? input.invocationNum ?? input.stepIdx ?? "turn"));
    if (event === "Stop" && task.lastStop === turnKey) return;

    task.revision++;
    const elapsed = Math.max(0, now - task.updatedAt);
    task.updatedAt = now;

    if (event === "PreInvocation") {
      if (promptText && task.segment.prompts.at(-1) !== promptText) {
        task.segment.prompts.push(promptText);
        task.segment.prompts = task.segment.prompts.slice(-10);
      }
      task.due = null;
      task.state = "collecting";
      task.message = "Сбор контекста";
    } else if (event === "PostToolUse") {
      if (promptText && !task.segment.prompts.length) {
        task.segment.prompts.push(promptText);
      }
      task.segment.tools.push(...taskTool(input, config, io.root));
      task.segment.tools = task.segment.tools.slice(-150);
    } else if (event === "Stop") {
      if (assistantReply) {
        task.segment.answers.push(assistantReply);
        task.segment.answers = task.segment.answers.slice(-10);
      }
      task.segment.turns.push({ turnId: turnKey, durationMs: elapsed, usage: emptyUsage() });
      task.segment.turns = task.segment.turns.slice(-20);
      task.lastStop = turnKey;
      task.due = now + Math.max(1, config.analyzer.idleSeconds) * 1000;
      task.state = "pending";
      task.message = "Ожидание паузы перед анализом";
    }

    await atomic(io, taskPath(session), task);
  });
};

export const analysisStatus = async (
  io: Io,
): Promise<{ enabled: boolean; tasks: { state: Task["state"]; message: string; updatedAt: number }[] }> => {
  const config = await loadConfig(io);
  const names = (await io.list(`${BASE}/tasks`)).filter((n) => /^[a-f0-9]{32}\.json$/.test(n));
  const tasks = await Promise.all(names.map((n) => readTask(io, n.slice(0, -5))));
  return {
    enabled: config.antigravity.enabled,
    tasks: tasks
      .filter((t): t is Task => Boolean(t))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10)
      .map(({ state, message, updatedAt }) => ({ state, message, updatedAt })),
  };
};

export const processTask = async (io: Io, session: string, llm?: Llm, now = Date.now()): Promise<boolean> => {
  const config = await loadConfig(io);
  if (!config.enabled || !config.antigravity.enabled) return false;
  const task = await withLock(io, async () => {
    const currentTask = await readTask(io, session);
    if (!currentTask || currentTask.due === null || currentTask.due > now || !["pending", "postponed", "analysing"].includes(currentTask.state)) {
      return;
    }
    const noContext = !currentTask.segment.prompts.some((p) => p.trim());
    if (noContext || isTrivial(computeSignals(currentTask.segment), config)) {
      await atomic(io, taskPath(session), {
        ...currentTask,
        state: "done",
        due: null,
        message: noContext ? "Недостаточно контекста: текст запроса недоступен" : "Пропущено: простая задача",
        updatedAt: Date.now(),
      });
      return;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const path = `${BASE}/budget-${day}.json`;
    const budget = JSON.parse((await io.read(path)) ?? '{"calls":0,"tokens":0}') as { calls: number; tokens: number };
    if (budget.calls >= config.antigravity.maxCallsPerDay || budget.tokens >= config.analyzer.maxTokensPerDay) {
      currentTask.state = "postponed";
      currentTask.message = "Дневной бюджет исчерпан; повтор через 15 минут";
      currentTask.due = now + 900_000;
      await atomic(io, taskPath(session), currentTask);
      return;
    }
    await atomic(io, path, { calls: budget.calls + 1, tokens: budget.tokens + 50_000 });
    currentTask.state = "analysing";
    currentTask.message = "Анализируется";
    currentTask.attempts++;
    await atomic(io, taskPath(session), currentTask);
    return currentTask;
  });

  if (!task) return false;

  const controller = new AbortController();
  const current = async () => {
    const latest = await loadConfig(io);
    return latest.enabled && latest.antigravity.enabled && (await readTask(io, session))?.revision === task.revision;
  };
  const monitor = setInterval(() => {
    void current()
      .then((valid) => {
        if (!valid) controller.abort();
      })
      .catch(() => controller.abort());
  }, 500);

  let message: string;
  let state: Task["state"] = "done";
  let tokens: number | undefined;
  try {
    const result = await analyzeSegment({
      io,
      llm: llm ?? agyLlm(config.antigravity, controller.signal),
      config: {
        ...config,
        analyzer: { ...config.analyzer, reflect: "digest" },
        apply: { autoTypes: [], autoConfidence: 2 },
        review: { ...config.review, promoteOnRepeat: false },
      },
      segment: task.segment,
      now: new Date(now),
      reviewOnly: true,
      shouldCommit: current,
    });
    tokens = weightedTokens(result.usage);
    message =
      result.kind === "skipped"
        ? `Пропущено: ${result.reason}`
        : `Анализ завершён · на ревью: ${result.report.proposals.length}`;
  } catch (err) {
    state = task.attempts < 3 ? "postponed" : "failed";
    const reason = safeText(err instanceof Error ? err.message : "unknown error", config.privacy.excludePaths, io.root, 200);
    message = `${state === "failed" ? "Анализ не удался после трёх попыток" : "Ошибка анализа; повтор через 15 минут"}: ${reason}`;
  } finally {
    clearInterval(monitor);
  }

  await withLock(io, async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    const path = `${BASE}/budget-${day}.json`;
    const budget = JSON.parse((await io.read(path)) ?? '{"calls":0,"tokens":0}') as { calls: number; tokens: number };
    if (tokens !== undefined && tokens > 0) {
      await atomic(io, path, { ...budget, tokens: Math.max(0, budget.tokens - 50_000 + tokens) });
    }
    if (!(await current())) return;
    const next: Task = {
      ...task,
      state,
      message,
      due: state === "postponed" ? now + 900_000 : null,
      updatedAt: Date.now(),
    };
    await atomic(io, taskPath(session), next);
  });
  return true;
};

export const runWorker = async (root: string, llm?: Llm, opts?: { once?: boolean }): Promise<void> => {
  const io = nodeIo(root, "antigravity");
  await mkdir(join(root, BASE), { recursive: true });
  const lock = `${BASE}/worker-lock`;
  if (!(await io.mutex!.claim(lock))) {
    if (((await io.mutex!.age(lock)) ?? 0) < 15 * 60_000) return;
    await io.mutex!.release(lock);
    if (!(await io.mutex!.claim(lock))) return;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(join(root, lock), now, now).catch(() => {});
  }, 5000);
  try {
    while (true) {
      const config = await loadConfig(io);
      if (!config.enabled || !config.antigravity.enabled) break;
      const names = (await io.list(`${BASE}/tasks`)).filter((n) => /^[a-f0-9]{32}\.json$/.test(n));
      let waiting = false;
      for (const name of names) {
        const session = name.slice(0, -5);
        const task = await readTask(io, session);
        if (!task || task.due === null) continue;
        waiting = true;
        await processTask(io, session, llm);
      }
      if (!waiting || opts?.once) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    clearInterval(heartbeat);
    await io.mutex!.release(lock);
  }
};
