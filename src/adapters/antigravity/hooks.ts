import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findRoot, nodeIo } from "../../cli/node-io.js";
import { loadConfig } from "../../core/config.js";
import { relPath } from "../../core/io.js";
import { loadState } from "../../core/ledger.js";
import { withLock } from "../../core/lock.js";
import { isExcluded } from "../../core/privacy.js";
import { renderAll, renderCore } from "../../core/render.js";
import { loadUsage } from "../../core/usage.js";
import { BASE, captureTask } from "./queue.js";
import { registerWorkspace } from "./registry.js";

export const EVENTS = new Set(["SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"]);
const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

export interface CapturedEvent {
  v: 1;
  event: string;
  session: string;
  step?: number;
  tool?: string;
  call?: string;
  ok?: boolean;
  at: string;
  fields: string[];
  files: string[];
}

export const resolveHookRoot = (input: Record<string, unknown>): string | undefined => {
  const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const first = workspaces.find((p): p is string => typeof p === "string" && p.trim().length > 0);
  const base = first ?? (typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : undefined);
  return base ? findRoot(base) : undefined;
};

export const capture = (
  input: Record<string, unknown>,
  excluded: string[],
  root = "",
  at = new Date().toISOString(),
): CapturedEvent | undefined => {
  const eventName = input.hookEventName;
  const convId = input.conversationId;
  if (typeof eventName !== "string" || !EVENTS.has(eventName) || typeof convId !== "string" || !convId) return;

  const toolCall = input.toolCall && typeof input.toolCall === "object" ? (input.toolCall as Record<string, unknown>) : {};
  const args = toolCall.args && typeof toolCall.args === "object" ? (toolCall.args as Record<string, unknown>) : {};
  const files: string[] = [];
  for (const key of ["Path", "TargetFile", "AbsolutePath", "path", "file_path"]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      const rel = root ? relPath(root, val.trim()) : val.trim();
      if (!rel.startsWith("/") && !rel.split("/").includes("..") && !isExcluded(rel, excluded)) {
        files.push(rel);
      }
    }
  }

  return {
    v: 1,
    event: eventName,
    session: hash(convId),
    ...(typeof input.stepIdx === "number" ? { step: input.stepIdx } : {}),
    ...(typeof toolCall.name === "string" ? { tool: toolCall.name.slice(0, 200) } : {}),
    ...(typeof toolCall.id === "string" ? { call: hash(toolCall.id) } : {}),
    ...(eventName === "PostToolUse" ? { ok: !(typeof input.error === "string" && input.error.trim()) } : {}),
    at,
    fields: Object.keys(input).sort().slice(0, 50),
    files: [...new Set(files)].slice(0, 100),
  };
};

export const handleHook = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (process.env.ARCHIVIST_CHILD) return {};
  const root = resolveHookRoot(input);
  if (!root) return {};
  const convId = typeof input.conversationId === "string" ? input.conversationId : undefined;
  await registerWorkspace(root, convId);

  const io = nodeIo(root, "antigravity");
  const config = await loadConfig(io);
  if (!config.enabled) return {};

  const event = capture(input, config.privacy.excludePaths, root);
  if (!event) return {};

  await io.write(`${BASE}/collector.json`, JSON.stringify({ v: 1, contentCaptured: config.antigravity.enabled }) + "\n");
  const dir = join(io.root, BASE, "events", event.session);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const identity = event.call
    ? `${event.event}:${event.call}`
    : event.step !== undefined
      ? `${event.event}:${event.step}`
      : `${event.event}:${event.at}`;

  const file = await open(join(dir, `${hash(identity)}.json`), "wx", 0o600).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
    return undefined;
  });

  if (file) {
    try {
      await file.writeFile(JSON.stringify(event) + "\n");
    } finally {
      await file.close();
    }
  }

  if (config.antigravity.enabled && file) {
    await captureTask(io, input, config);
  }

  if (event.event === "SessionStart") {
    const text = await withLock(io, async () => {
      const state = await loadState(io);
      if (!state.entries.size) return "";
      const result = await renderAll(io, state.entries, config);
      return renderCore([...state.entries.values()], config, result.stale, await loadUsage(io));
    });
    if (!text) return {};
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: `${text}\nScoped knowledge: use the Archivist recall skill or CLI before exploring.\n`,
          },
        },
      ],
    };
  }

  return {};
};

export interface CollectionStats {
  sessions: number;
  events: number;
  counts: Record<string, number>;
  modelCallsUpperBound: number;
  contentCaptured: boolean;
  analysisEnabled: boolean;
}

export const collectionStats = async (root: string): Promise<CollectionStats> => {
  const dir = join(root, BASE, "events");
  const sessions = await readdir(dir).catch(() => [] as string[]);
  const counts: Record<string, number> = {};
  let total = 0;
  let validSessions = 0;
  for (const session of sessions) {
    if (!/^[a-f0-9]{32}$/.test(session)) continue;
    validSessions++;
    for (const file of await readdir(join(dir, session)).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      try {
        const e = JSON.parse(await readFile(join(dir, session, file), "utf8")) as CapturedEvent;
        counts[e.event] = (counts[e.event] ?? 0) + 1;
        total++;
      } catch {}
    }
  }
  const io = nodeIo(root, "antigravity");
  const config = await loadConfig(io);
  const tasks = await io.list(`${BASE}/tasks`);
  const budgets = (await io.list(BASE)).filter((n) => /^budget-.*\.json$/.test(n));
  let modelCalls = 0;
  for (const name of budgets) {
    try {
      modelCalls += Number((JSON.parse((await io.read(`${BASE}/${name}`)) ?? "{}") as { calls?: number }).calls ?? 0);
    } catch {}
  }
  return {
    sessions: validSessions,
    events: total,
    counts,
    modelCallsUpperBound: modelCalls,
    contentCaptured: tasks.some((n) => n.endsWith(".json")),
    analysisEnabled: config.antigravity.enabled,
  };
};

export const collectionSummary = async (root: string): Promise<string> =>
  JSON.stringify(await collectionStats(root), null, 2);
