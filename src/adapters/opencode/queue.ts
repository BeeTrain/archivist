import { createHash, randomBytes } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { analyzeSegment } from "../../analyzer/pipeline.js";
import { computeSignals, isTrivial } from "../../analyzer/signals.js";
import { safeText } from "../../core/capture.js";
import { loadConfig, type Config } from "../../core/config.js";
import type { Io, Llm } from "../../core/io.js";
import { withLock } from "../../core/lock.js";
import { weightedTokens, type Segment, type Usage } from "../../core/types.js";
import { captureTool, type ToolInput } from "./capture.js";
import type { ModelRef } from "./llm.js";
import type { UiResult } from "./rpc.js";

export const BASE = ".archivist/.local/opencode";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const taskPath = (session: string) => `${BASE}/tasks/${hash(session)}.json`;

export interface Task {
  sessionID: string;
  segment: Segment;
  model?: ModelRef;
  revision: number;
  seen: string[];
  due: number | null;
  idleRevision?: number;
  attempts: number;
  owner?: string;
  state: "collecting" | "pending" | "analysing" | "done" | "postponed" | "failed";
  message: string;
  updatedAt: number;
  lastResult?: UiResult;
}

const readTask = async (io: Io, session: string): Promise<Task | undefined> => {
  const raw = await io.read(taskPath(session));
  return raw ? JSON.parse(raw) as Task : undefined;
};

const atomic = async (io: Io, path: string, value: unknown) => {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await io.write(temp, JSON.stringify(value) + "\n");
  await rename(join(io.root, temp), join(io.root, path));
};

export const tasks = async (io: Io): Promise<Task[]> => {
  const names = (await io.list(`${BASE}/tasks`)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  return Promise.all(names.map(async (name) => JSON.parse((await io.read(`${BASE}/tasks/${name}`))!) as Task));
};

export const analysisSnapshot = async (io: Io) => {
  const config = await loadConfig(io);
  const recent = (await tasks(io)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  return { enabled: config.enabled && config.opencode.enabled, model: config.opencode.model, maxCallsPerDay: config.opencode.maxCallsPerDay, tasks: recent.map(({ state, message, updatedAt }) => ({ state, message, updatedAt })) };
};

export const analysisStatus = async (io: Io): Promise<string> => {
  const snapshot = await analysisSnapshot(io);
  return [
    `OpenCode analysis: ${snapshot.enabled ? "enabled" : "disabled"}`,
    `Model: ${snapshot.model || "current session model"}`,
    `Daily call limit: ${snapshot.maxCallsPerDay}; token usage is estimated`,
    ...snapshot.tasks.map((task) => `${task.state}: ${task.message}`),
  ].join("\n");
};

export class Collector {
  private readonly running = new Map<string, AbortController>();
  private closed = false;

  constructor(readonly io: Io, private readonly llm: (config: Config, model: ModelRef | undefined, signal: AbortSignal) => Llm) {}

  async invalidate(session: string): Promise<void> {
    this.running.get(session)?.abort();
    await withLock(this.io, async () => {
      const task = await readTask(this.io, session);
      if (!task || ["done", "failed"].includes(task.state)) return;
      task.revision++;
      task.due = null;
      task.state = "collecting";
      task.message = "Сбор контекста";
      await atomic(this.io, taskPath(session), task);
    });
  }

  private async capture(session: string, key: string, update: (task: Task, config: Config) => void, create = false, now = Date.now()): Promise<void> {
    if (this.closed) return;
    await withLock(this.io, async () => {
      const config = await loadConfig(this.io);
      if (!config.enabled || !config.opencode.enabled) return;
      let task = await readTask(this.io, session);
      const id = hash(key);
      if (task?.seen.includes(id)) return;
      if (!task || ["done", "failed"].includes(task.state)) {
        if (!create) return;
        task = {
          sessionID: session,
          segment: { id: hash(`${session}:${key}`), session: hash(session), startedAt: now, prompts: [], answers: [], tools: [], turns: [], rulesLoaded: [] },
          seen: task?.seen ?? [], revision: (task?.revision ?? 0) + 1, due: null, attempts: 0,
          state: "collecting", message: "Сбор контекста", updatedAt: now, lastResult: task?.lastResult,
        };
      }
      this.running.get(session)?.abort();
      task.seen = [...task.seen, id].slice(-500);
      task.revision++;
      task.updatedAt = now;
      task.due = null;
      task.state = "collecting";
      update(task, config);
      await atomic(this.io, taskPath(session), task);
    });
  }

  prompt(session: string, id: string, text: string, now = Date.now()): Promise<void> {
    return this.capture(session, `prompt:${id}`, (task, config) => {
      task.segment.prompts = [...task.segment.prompts, safeText(text, config.privacy.excludePaths, this.io.root)].slice(-10);
      task.attempts = 0;
    }, true, now);
  }

  tool(session: string, id: string, event: ToolInput): Promise<void> {
    return this.capture(session, `tool:${id}`, (task, config) => {
      task.segment.tools = [...task.segment.tools, ...captureTool(event, this.io.root, config)].slice(-150);
    });
  }

  answer(session: string, id: string, text: string): Promise<void> {
    return this.capture(session, `answer:${id}`, (task, config) => {
      task.segment.answers = [...task.segment.answers, safeText(text, config.privacy.excludePaths, this.io.root)].slice(-10);
    });
  }

  async model(session: string, model: ModelRef): Promise<void> {
    await withLock(this.io, async () => {
      const task = await readTask(this.io, session);
      if (!task || JSON.stringify(task.model) === JSON.stringify(model)) return;
      task.model = model;
      await atomic(this.io, taskPath(session), task);
    });
  }

  step(session: string, id: string, usage: Usage, model?: ModelRef): Promise<void> {
    return this.capture(session, `step:${id}`, (task) => {
      task.model ??= model;
      task.segment.turns = [...task.segment.turns, { turnId: hash(id), durationMs: 0, usage }].slice(-30);
    });
  }

  async idle(session: string, model?: ModelRef, now = Date.now()): Promise<void> {
    await withLock(this.io, async () => {
      const config = await loadConfig(this.io);
      const task = await readTask(this.io, session);
      if (!task || !config.enabled || !config.opencode.enabled || ["done", "failed"].includes(task.state) || task.idleRevision === task.revision) return;
      task.idleRevision = task.revision;
      task.model ??= model;
      task.due = now + Math.max(1, config.analyzer.idleSeconds) * 1000;
      task.state = "pending";
      task.message = "Ожидание паузы перед анализом";
      task.updatedAt = now;
      await atomic(this.io, taskPath(session), task);
    });
  }

  async process(session: string, now = Date.now(), isIdle: () => Promise<boolean> = async () => true): Promise<boolean> {
    if (this.closed || this.running.has(session) || !(await isIdle())) return false;
    const config = await loadConfig(this.io);
    if (!config.enabled || !config.opencode.enabled) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    const budgetPath = `${BASE}/budget-${day}.json`;
    const readBudget = async (): Promise<{ calls: number; tokens: number }> => JSON.parse((await this.io.read(budgetPath)) ?? '{"calls":0,"tokens":0}');
    const task = await withLock(this.io, async () => {
      const task = await readTask(this.io, session);
      if (!task || task.due === null || task.due > now || !["pending", "postponed", "analysing"].includes(task.state)) return;
      if (!task.segment.prompts.some((p) => p.trim()) || isTrivial(computeSignals(task.segment), config)) {
        await atomic(this.io, taskPath(session), { ...task, state: "done", due: null, message: "Пропущено: простая задача или нет текста запроса" });
        return;
      }
      const budget = await readBudget();
      if (budget.calls >= config.opencode.maxCallsPerDay || budget.tokens + 50000 > config.analyzer.maxTokensPerDay) {
        await atomic(this.io, taskPath(session), { ...task, state: "postponed", due: now + 900000, message: "Дневной бюджет исчерпан; повтор через 15 минут" });
        return;
      }
      await atomic(this.io, budgetPath, { calls: budget.calls + 1, tokens: budget.tokens + 50000 });
      task.owner = randomBytes(12).toString("hex");
      task.state = "analysing";
      task.attempts++;
      task.due = now + Math.max(1, Math.min(600, config.opencode.timeoutSeconds)) * 1000 + 60000;
      task.message = "Анализируется";
      await atomic(this.io, taskPath(session), task);
      return task;
    });
    if (!task) return false;
    const controller = new AbortController();
    this.running.set(session, controller);
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(600, config.opencode.timeoutSeconds)) * 1000);
    const current = async () => {
      const latest = await loadConfig(this.io);
      const stored = await readTask(this.io, session);
      return !this.closed && !controller.signal.aborted && latest.enabled && latest.opencode.enabled && stored?.revision === task.revision && stored?.owner === task.owner && await isIdle();
    };
    const monitor = setInterval(() => { void current().then((valid) => { if (!valid) controller.abort(); }).catch(() => controller.abort()); }, 500);
    let state: Task["state"] = "done";
    let message = "Анализ завершён";
    let tokens: number | undefined;
    let lastResult = task.lastResult;
    try {
      const result = await analyzeSegment({
        io: this.io, config: { ...config, analyzer: { ...config.analyzer, reflect: "digest" }, apply: { autoTypes: [], autoConfidence: 2 }, review: { ...config.review, promoteOnRepeat: false } },
        llm: this.llm(config, task.model, controller.signal), segment: task.segment, reviewOnly: true,
        shouldCommit: current, now: new Date(now),
      });
      tokens = weightedTokens(result.usage);
      message = result.kind === "done" ? `Анализ завершён · на ревью: ${result.report.proposals.length}` : `Пропущено: ${result.reason}`;
      if (result.kind === "done") lastResult = {
        id: hash(`${task.segment.id}:${task.attempts}:${now}`), segment: task.segment.id, at: Date.now(),
        summary: safeText(result.report.summary, config.privacy.excludePaths, this.io.root, 1000),
        proposed: result.report.proposals.length, applied: result.report.applied.length, reportPath: result.reportPath,
      };
    } catch {
      state = task.attempts < 3 ? "postponed" : "failed";
      message = state === "failed" ? "Анализ не удался после трёх попыток" : "Ошибка анализа; повтор через 15 минут";
    } finally {
      clearTimeout(timeout);
      clearInterval(monitor);
      this.running.delete(session);
    }
    await withLock(this.io, async () => {
      if (tokens !== undefined && tokens > 0) {
        const budget = await readBudget();
        await atomic(this.io, budgetPath, { ...budget, tokens: Math.max(0, budget.tokens - 50000 + tokens) });
      }
      const stored = await readTask(this.io, session);
      if (this.closed || stored?.revision !== task.revision || stored.owner !== task.owner) return;
      await atomic(this.io, taskPath(session), { ...task, state, message, lastResult, due: state === "postponed" ? now + 900000 : null, updatedAt: Date.now() });
    });
    return true;
  }

  async remove(session: string): Promise<void> {
    this.running.get(session)?.abort();
    await withLock(this.io, async () => { await this.io.remove?.(taskPath(session)); });
  }

  close(): void {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
  }
}
