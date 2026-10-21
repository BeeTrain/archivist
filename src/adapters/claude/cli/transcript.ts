// Reads Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl) into the same segments
// the mod journals live, so the baseline is measured by the same code as the tasks after it.
//
// The format is internal to Claude Code and changes between versions (docs/spikes.md §4): read the few record
// types we need, skip everything else, never fail on a line.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { relPath } from "../../../core/io.js";
import { truncate } from "../../../core/text.js";
import { addUsage, emptyUsage, type Segment, type ToolEvent } from "../../../core/types.js";

/** Claude Code names a project's transcript folder after its path, every non-alphanumeric character as '-'. */
export const transcriptDir = (root: string, home = homedir()): string => join(home, ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: string };
type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { id?: string; content?: string | Block[]; usage?: Record<string, number> };
};

const target = (root: string, tool: string, input: Record<string, unknown> = {}): string | undefined => {
  const v = input.file_path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.path ?? input.url;
  if (typeof v !== "string") return undefined;
  return tool === "Bash" ? truncate(v.replace(/\s+/g, " ").trim(), 200) : relPath(root, v);
};

const promptText = (l: Line): string | undefined => {
  if (l.type !== "user" || l.isMeta || l.isSidechain) return undefined;
  const c = l.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) && !c.some((b) => b.type === "tool_result") ? c.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : undefined;
  // Slash-command and local-command wrappers are not prompts of a task.
  return text && text.trim() && !/^<(command|local-command)/.test(text.trim()) ? text : undefined;
};

/** One segment per user prompt: the same unit the live journal calls a task, minus the idle-merging. */
export const segmentsFromTranscript = (text: string, root: string, session: string): Segment[] => {
  const segments: Segment[] = [];
  const pending = new Map<string, ToolEvent>();
  const usageById = new Map<string, Record<string, number>>();
  let seg: Segment | undefined;
  let first = 0;
  let last = 0;

  const close = () => {
    if (!seg) return;
    let usage = emptyUsage();
    for (const u of usageById.values())
      usage = addUsage(usage, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
    seg.turns = [{ turnId: `${seg.id}-0`, durationMs: Math.max(0, last - first), usage }];
    segments.push(seg);
    usageById.clear();
    pending.clear();
  };

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const t = l.timestamp ? Date.parse(l.timestamp) : NaN;
    const prompt = promptText(l);
    if (prompt) {
      close();
      seg = { id: `${session.slice(0, 8)}-${segments.length}`, session, startedAt: Number.isNaN(t) ? 0 : t, prompts: [prompt], answers: [], turns: [], tools: [], rulesLoaded: [] };
      first = last = Number.isNaN(t) ? 0 : t;
      continue;
    }
    if (!seg || l.isSidechain) continue;
    if (!Number.isNaN(t)) last = t;
    const blocks = Array.isArray(l.message?.content) ? l.message!.content : [];
    if (l.type === "assistant") {
      // One record per content block, all sharing the message's id and usage: count each message once.
      if (l.message?.id && l.message.usage) usageById.set(l.message.id, l.message.usage);
      for (const b of blocks) {
        if (b.type !== "tool_use" || !b.id || !b.name) continue;
        const ev: ToolEvent = { tool: b.name, ok: true };
        const tg = target(root, b.name, b.input);
        if (tg) ev.target = tg;
        pending.set(b.id, ev);
        seg.tools.push(ev);
      }
    } else if (l.type === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const ev = pending.get(b.tool_use_id);
        if (!ev || !b.is_error) continue;
        ev.ok = false;
        const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        ev.error = truncate(body.replace(/\s+/g, " "), 300);
      }
    }
  }
  close();
  return segments;
};

/** Every session of the project that started before `before`. */
export const readProjectSegments = async (root: string, before: Date, dir = transcriptDir(root)): Promise<{ sessions: number; segments: Segment[] }> => {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { sessions: 0, segments: [] };
  }
  const segments: Segment[] = [];
  let sessions = 0;
  for (const name of names) {
    const segs = segmentsFromTranscript(await readFile(join(dir, name), "utf8"), root, name.replace(/\.jsonl$/, "")).filter((s) => s.startedAt < before.getTime());
    if (segs.length) sessions++;
    segments.push(...segs);
  }
  return { sessions, segments };
};
