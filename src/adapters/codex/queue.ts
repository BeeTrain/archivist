import { createHash, randomBytes } from "node:crypto";
import { rename, mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../../cli/node-io.js";
import { loadConfig, type Config } from "../../core/config.js";
import { withLock } from "../../core/lock.js";
import { redact, isExcluded } from "../../core/privacy.js";
import { emptyUsage, weightedTokens, type Segment, type ToolEvent } from "../../core/types.js";
import { analyzeSegment } from "../../analyzer/pipeline.js";
import { computeSignals, isTrivial } from "../../analyzer/signals.js";
import type { Io, Llm } from "../../core/io.js";
import { codexLlm } from "./llm.js";

const BASE = ".archivist/.local/codex";
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
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

const taskPath = (session: string) => `${BASE}/tasks/${session}.json`;
const readTask = async (io: Io, session: string): Promise<Task | undefined> => {
  const text = await io.read(taskPath(session));
  return text ? JSON.parse(text) as Task : undefined;
};
const atomic = async (io: Io, path: string, value: unknown) => {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await io.write(tmp, JSON.stringify(value) + "\n");
  await rename(join(io.root, tmp), join(io.root, path));
};

export const safeText = (value: unknown, excluded: string[], root: string, max = 6000): string => {
  if (typeof value !== "string") return "";
  const lines = value.slice(0, 60000).split("\n").filter((line) => !line.split(/[\s\x60"'<>()[\]{},;=]+/).some((word) => {
    const path = word.replace(root + "/", "").replace(/^\.\//, "").replace(/[:.!?]+$/, "");
    return path && isExcluded(path, excluded);
  }));
  return redact(lines.join("\n")).text.slice(0, max);
};

export const taskTool = (input: Record<string, unknown>, config: Config, root: string): ToolEvent[] => {
  const name = String(input.tool_name ?? "");
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  const clean = (s: unknown) => safeText(s, config.privacy.excludePaths, root, 400);
  if (/apply_patch$/.test(name)) {
    const patch = String(args.command ?? args.patch ?? input.tool_input ?? "");
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].flatMap((m) => {
      const path = clean(m[1]);
      return path && !path.startsWith("/") && !path.split("/").includes("..") ? [{ tool: "Edit", target: path, ok: true }] : [];
    });
  }
  const target = clean(args.cmd ?? args.command ?? args.file_path ?? args.path);
  const tool = /exec_command$|^Bash$/.test(name) ? "Bash" : /Read|read_file/.test(name) ? "Read" : /Edit|Write/.test(name) ? "Edit" : name.slice(0, 100);
  const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response as Record<string, unknown> : {};
  const ok = input.is_error !== true && response.isError !== true && !(typeof response.exit_code === "number" && response.exit_code !== 0);
  const error = !ok && target ? clean(response.output ?? response.error) : "";
  return [{ tool, ...(target ? { target } : {}), ok, ...(error ? { error } : {}) }];
};

export const captureTask = async (io: Io, input: Record<string, unknown>, config: Config, now = Date.now()): Promise<void> => {
  const event = input.hook_event_name;
  if (typeof input.session_id !== "string" || !["UserPromptSubmit", "PostToolUse", "Stop", "Interrupt", "SessionEnd"].includes(String(event))) return;
  const session = hash(input.session_id);
  await withLock(io, async () => {
    let task = await readTask(io, session);
    if (!task || task.state === "done" || task.state === "failed") {
      if (event !== "UserPromptSubmit") return;
      task = { segment: { id: hash(`${session}:${input.turn_id ?? now}`), session, startedAt: now, prompts: [], answers: [], turns: [], tools: [], rulesLoaded: [] }, revision: 0, due: null, attempts: 0, state: "collecting", message: "Сбор контекста", updatedAt: now };
    }
    const turn = hash(String(input.turn_id ?? "unknown"));
    if (event === "Stop" && task.lastStop === turn) return;
    task.revision++;
    const elapsed = now - task.updatedAt;
    task.updatedAt = now;
    const clean = (value: unknown) => safeText(value, config.privacy.excludePaths, io.root);
    if (event === "UserPromptSubmit") {
      task.segment.prompts.push(clean(input.prompt));
      task.segment.prompts = task.segment.prompts.slice(-10);
      task.due = null;
      task.state = "collecting";
      task.message = "Сбор контекста";
    } else if (event === "PostToolUse") {
      task.segment.tools.push(...taskTool(input, config, io.root));
      task.segment.tools = task.segment.tools.slice(-150);
    } else {
      task.segment.answers.push(clean(input.last_assistant_message));
      task.segment.answers = task.segment.answers.slice(-10);
      task.segment.turns.push({ turnId: turn, durationMs: elapsed, usage: emptyUsage() });
      task.segment.turns = task.segment.turns.slice(-20);
      if (event === "Stop") task.lastStop = turn;
      task.due = now + Math.max(1, config.analyzer.idleSeconds) * 1000;
      task.state = "pending";
      task.message = "Ожидание паузы перед анализом";
    }
    await atomic(io, taskPath(session), task);
  });
};

export const analysisStatus = async (io: Io): Promise<{ enabled: boolean; tasks: { state: Task["state"]; message: string; updatedAt: number }[] }> => {
  const config = await loadConfig(io);
  const names = (await io.list(`${BASE}/tasks`)).filter((n) => /^[a-f0-9]{32}\.json$/.test(n));
  const tasks = await Promise.all(names.map((n) => readTask(io, n.slice(0, -5))));
  return { enabled: config.codex.enabled, tasks: tasks.filter((t): t is Task => !!t).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map(({ state, message, updatedAt }) => ({ state, message, updatedAt })) };
};

export const processTask = async (io: Io, session: string, llm?: Llm, now = Date.now()): Promise<boolean> => {
  const config = await loadConfig(io);
  if (!config.enabled || !config.codex.enabled) return false;
  const task = await withLock(io, async () => {
    const task = await readTask(io, session);
    if (!task || task.due === null || task.due > now || !["pending", "postponed", "analysing"].includes(task.state)) return;
    const noContext = !task.segment.prompts.some((p) => p.trim());
    if (noContext || isTrivial(computeSignals(task.segment), config)) {
      await atomic(io, taskPath(session), { ...task, state: "done", due: null, message: noContext ? "Недостаточно контекста: текст запроса недоступен" : "Пропущено: простая задача" });
      return;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const path = `${BASE}/budget-${day}.json`;
    const budget = JSON.parse((await io.read(path)) ?? '{"calls":0,"tokens":0}');
    if (budget.calls >= config.codex.maxCallsPerDay || budget.tokens >= config.analyzer.maxTokensPerDay) {
      task.state = "postponed";
      task.message = "Дневной бюджет исчерпан; повтор через 15 минут";
      task.due = now + 900000;
      await atomic(io, taskPath(session), task);
      return;
    }
    await atomic(io, path, { calls: budget.calls + 1, tokens: budget.tokens + 50000 });
    task.state = "analysing";
    task.message = "Анализируется";
    task.attempts++;
    await atomic(io, taskPath(session), task);
    return task;
  });
  if (!task) return false;
  const controller = new AbortController();
  const current = async () => {
    const latest = await loadConfig(io);
    return latest.enabled && latest.codex.enabled && (await readTask(io, session))?.revision === task.revision;
  };
  const monitor = setInterval(() => { void current().then((valid) => { if (!valid) controller.abort(); }).catch(() => controller.abort()); }, 500);
  let message: string;
  let state: Task["state"] = "done";
  let tokens: number | undefined;
  try {
    const result = await analyzeSegment({ io, llm: llm ?? codexLlm(config.codex, controller.signal), config: { ...config, analyzer: { ...config.analyzer, reflect: "digest" }, apply: { autoTypes: [], autoConfidence: 2 }, review: { ...config.review, promoteOnRepeat: false } }, segment: task.segment, now: new Date(now), reviewOnly: true, shouldCommit: current });
    tokens = weightedTokens(result.usage);
    message = result.kind === "skipped" ? `Пропущено: ${result.reason}` : `Анализ завершён · на ревью: ${result.report.proposals.length}`;
  } catch (err) {
    state = task.attempts < 3 ? "postponed" : "failed";
    const reason = safeText(err instanceof Error ? err.message : "unknown error", config.privacy.excludePaths, io.root, 200);
    message = `${state === "failed" ? "Анализ не удался после трёх попыток" : "Ошибка анализа; повтор через 15 минут"}: ${reason}`;
  } finally { clearInterval(monitor); }
  await withLock(io, async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    const path = `${BASE}/budget-${day}.json`;
    const budget = JSON.parse((await io.read(path)) ?? '{"calls":0,"tokens":0}');
    if (tokens !== undefined && tokens > 0) await atomic(io, path, { ...budget, tokens: Math.max(0, budget.tokens - 50000 + tokens) });
    if (!(await current())) return;
    const next = { ...task, state, message, due: state === "postponed" ? now + 900000 : null, updatedAt: Date.now() };
    await atomic(io, taskPath(session), next);
  });
  return true;
};

export const runWorker = async (root: string, llm?: Llm): Promise<void> => {
  const io = nodeIo(root, "codex");
  await mkdir(join(root, BASE), { recursive: true });
  const lock = `${BASE}/worker-lock`;
  if (!(await io.mutex!.claim(lock))) {
    if ((await io.mutex!.age(lock) ?? 0) < 15 * 60000) return;
    await io.mutex!.release(lock);
    if (!(await io.mutex!.claim(lock))) return;
  }
  const heartbeat = setInterval(() => { const now = new Date(); void utimes(join(root, lock), now, now).catch(() => {}); }, 5000);
  try {
    while (true) {
      const config = await loadConfig(io);
      if (!config.enabled || !config.codex.enabled) break;
      const names = (await io.list(`${BASE}/tasks`)).filter((n) => /^[a-f0-9]{32}\.json$/.test(n));
      let waiting = false;
      for (const name of names) {
        const session = name.slice(0, -5);
        const task = await readTask(io, session);
        if (!task || task.due === null) continue;
        waiting = true;
        await processTask(io, session, llm);
      }
      if (!waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally { clearInterval(heartbeat); await io.mutex!.release(lock); }
  const config = await loadConfig(io);
  if (config.enabled && config.codex.enabled) {
    for (const name of (await io.list(`${BASE}/tasks`)).filter((n) => /^[a-f0-9]{32}\.json$/.test(n))) {
      if ((await readTask(io, name.slice(0, -5)))?.due != null) {
        await runWorker(root, llm);
        break;
      }
    }
  }
};
