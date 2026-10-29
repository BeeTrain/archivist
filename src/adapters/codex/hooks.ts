import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { loadState } from "../../core/ledger.js";
import { renderAll, renderCore } from "../../core/render.js";
import { isExcluded } from "../../core/privacy.js";
import { nodeIo, findRoot } from "../../cli/node-io.js";
import { withLock } from "../../core/lock.js";

export const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt", "SessionEnd"]);
const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);
export interface CapturedEvent {
  v: 1;
  event: string;
  session: string;
  turn?: string;
  tool?: string;
  call?: string;
  at: string;
  fields: string[];
  files: string[];
}

export const capture = (input: Record<string, unknown>, excluded: string[], at = new Date().toISOString()): CapturedEvent | undefined => {
  if (typeof input.hook_event_name !== "string" || !EVENTS.has(input.hook_event_name) || typeof input.session_id !== "string") return;
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  const files: string[] = [];
  if (input.tool_name === "apply_patch" && typeof args.command === "string") {
    for (const m of args.command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const path = m[1]!.trim();
      if (!path.startsWith("/") && !path.split("/").includes("..") && !isExcluded(path, excluded)) files.push(path);
    }
  }
  return {
    v: 1, event: input.hook_event_name, session: hash(input.session_id), at,
    ...(typeof input.turn_id === "string" ? { turn: hash(input.turn_id) } : {}),
    ...(typeof input.tool_name === "string" ? { tool: input.tool_name.slice(0, 200) } : {}),
    ...(typeof input.tool_use_id === "string" ? { call: hash(input.tool_use_id) } : {}),
    fields: Object.keys(input).sort().slice(0, 50), files: [...new Set(files)].slice(0, 100),
  };
};

export const handleHook = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (process.env.ARCHIVIST_CHILD || typeof input.cwd !== "string") return {};
  const io = nodeIo(findRoot(input.cwd), "codex");
  const config = await loadConfig(io);
  if (!config.enabled) return {};
  const event = capture(input, config.privacy.excludePaths);
  if (!event) return {};
  await io.write(".archivist/.local/codex/collector.json", JSON.stringify({ v: 1, contentCaptured: false }) + "\n");
  const dir = join(io.root, ".archivist/.local/codex/events", event.session);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const identity = event.call ? `${event.event}:${event.call}` : event.turn ? `${event.event}:${event.turn}` : `${event.event}:${event.at}`;
  const file = await open(join(dir, `${hash(identity)}.json`), "wx", 0o600).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
    return undefined;
  });
  if (file) {
    try { await file.writeFile(JSON.stringify(event) + "\n"); } finally { await file.close(); }
  }
  if (event.event === "SessionStart") {
    const text = await withLock(io, async () => {
      const state = await loadState(io);
      const result = await renderAll(io, state.entries, config);
      return renderCore([...state.entries.values()], config, result.stale);
    });
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${text}\nScoped knowledge: use the Archivist recall skill before exploring.\n` } };
  }
  return {};
};

export const collectionSummary = async (root: string): Promise<string> => {
  const dir = join(root, ".archivist/.local/codex/events");
  const sessions = await readdir(dir).catch(() => []);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const session of sessions) {
    if (!/^[a-f0-9]{32}$/.test(session)) continue;
    for (const file of await readdir(join(dir, session))) {
      if (!file.endsWith(".json")) continue;
      try {
        const e = JSON.parse(await readFile(join(dir, session, file), "utf8")) as CapturedEvent;
        counts[e.event] = (counts[e.event] ?? 0) + 1;
        total++;
      } catch {}
    }
  }
  return JSON.stringify({ sessions: sessions.length, events: total, counts, modelCalls: 0, contentCaptured: false }, null, 2);
};
