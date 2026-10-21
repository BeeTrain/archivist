// Deterministic waste signals, computed before any model call.
import type { Config } from "../core/config.js";
import { addUsage, emptyUsage, type Segment, type Usage } from "../core/types.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LOOK_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
/** Shell commands that only look around: they are exploration as much as Read and Grep are. */
const LOOK_COMMAND = /^(cat|head|tail|less|grep|rg|ag|find|fd|ls|tree|wc|sed -n|awk|jq)\b/;

/** Phrases that usually mean the user corrected the agent (ru/en). The analyzer model makes the final call. */
const CORRECTION = /(^|[\s,.!])(нет[,.!]|не так|неправильно|не надо|не нужно|запомни|remember[:,]|no[,.!]\s|wrong|don't|do not|instead)/i;

export interface Signals {
  turns: number;
  durationMs: number;
  usage: Usage;
  toolCalls: number;
  edits: string[];
  /** Read/Grep/Glob calls before the first edit: exploration cost. */
  readsBeforeFirstEdit: number;
  /** Files read more than once. */
  repeatedReads: { file: string; times: number }[];
  failedCommands: { command: string; error?: string }[];
  /** Failed commands later followed by a successful one starting the same way: a likely "right command" fact. */
  recoveredCommands: { failed: string; succeeded: string }[];
  corrections: string[];
  rulesLoaded: string[];
}

/** The last `&&`/`;` step of a command: `cd app && pnpm test` → `pnpm test`. */
const lastStep = (cmd: string): string => (cmd.split(/&&|;/).at(-1) ?? cmd).trim();
/** The program a command runs. */
const head = (cmd: string): string => lastStep(cmd).split(/\s+/)[0] ?? "";

export const computeSignals = (seg: Segment): Signals => {
  const edits: string[] = [];
  let readsBeforeFirstEdit = 0;
  const reads = new Map<string, number>();
  const failed: { command: string; error?: string }[] = [];
  const recovered: { failed: string; succeeded: string }[] = [];
  const open: string[] = [];

  for (const t of seg.tools) {
    if (EDIT_TOOLS.has(t.tool)) {
      if (t.target && !edits.includes(t.target)) edits.push(t.target);
    } else if (LOOK_TOOLS.has(t.tool)) {
      if (!edits.length) readsBeforeFirstEdit++;
      if (t.tool === "Read" && t.target) reads.set(t.target, (reads.get(t.target) ?? 0) + 1);
    } else if (t.tool === "Bash" && t.target) {
      if (t.ok && LOOK_COMMAND.test(lastStep(t.target))) {
        if (!edits.length) readsBeforeFirstEdit++;
        continue;
      }
      if (!t.ok) {
        failed.push({ command: t.target, ...(t.error ? { error: t.error } : {}) });
        open.push(t.target);
      } else {
        const i = open.findIndex((f) => head(f) === head(t.target!));
        if (i >= 0) {
          recovered.push({ failed: open[i]!, succeeded: t.target });
          open.splice(i, 1);
        }
      }
    }
  }

  return {
    turns: seg.turns.length,
    durationMs: seg.turns.reduce((s, t) => s + t.durationMs, 0),
    usage: seg.turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage()),
    toolCalls: seg.tools.length,
    edits,
    readsBeforeFirstEdit,
    repeatedReads: [...reads].filter(([, n]) => n > 1).map(([file, times]) => ({ file, times })),
    failedCommands: failed,
    recoveredCommands: recovered,
    corrections: seg.prompts.slice(1).filter((p) => CORRECTION.test(p)),
    rulesLoaded: [...new Set(seg.rulesLoaded.map((r) => r.file))],
  };
};

/** Most tasks should not produce knowledge; this is the cheap gate before any model call. */
export const isTrivial = (s: Signals, config: Config): boolean =>
  s.toolCalls < config.analyzer.minToolCalls && s.edits.length === 0 && s.corrections.length === 0 && s.failedCommands.length === 0;

export const signalsText = (s: Signals): string => {
  const lines = [
    `turns: ${s.turns}, tool calls: ${s.toolCalls}, files edited: ${s.edits.length}, reads before first edit: ${s.readsBeforeFirstEdit}`,
  ];
  if (s.edits.length) lines.push(`edited: ${s.edits.slice(0, 20).join(", ")}`);
  if (s.repeatedReads.length) lines.push(`re-read: ${s.repeatedReads.map((r) => `${r.file}×${r.times}`).join(", ")}`);
  for (const f of s.failedCommands.slice(0, 10)) lines.push(`failed command: ${f.command}${f.error ? ` → ${f.error}` : ""}`);
  for (const r of s.recoveredCommands) lines.push(`recovered: \`${r.failed}\` failed, then \`${r.succeeded}\` worked`);
  for (const c of s.corrections.slice(0, 5)) lines.push(`user correction?: ${c.slice(0, 200)}`);
  if (s.rulesLoaded.length) lines.push(`archivist rules loaded: ${s.rulesLoaded.join(", ")}`);
  return lines.join("\n");
};
