// How each entry fares in practice. Local, like the metrics: counters change every task and would only churn
// the repo. They drive decay (`archivist gc`) and the "harmful" alarm.
import type { Io } from "./io.js";
import type { Entry, ToolEvent } from "./types.js";

export const USAGE = ".archivist/.local/usage.json";

export interface EntryUsage {
  /** Times its rule file was loaded into a task (path-scoped files only: core.md loads every session). */
  seen: number;
  /** Times the task visibly applied it: ran the recorded command, or the agent said it used it. */
  used: number;
  helpful: number;
  harmful: number;
  lastUsed?: string;
}

export type UsageMap = Record<string, EntryUsage>;

export const loadUsage = async (io: Io): Promise<UsageMap> => {
  try {
    return JSON.parse((await io.read(USAGE)) ?? "{}") as UsageMap;
  } catch {
    return {};
  }
};

export const saveUsage = async (io: Io, u: UsageMap): Promise<void> => io.write(USAGE, JSON.stringify(u, null, 1) + "\n");

const bump = (u: UsageMap, id: string, field: "seen" | "used" | "helpful" | "harmful", ts?: string): void => {
  const e = (u[id] ??= { seen: 0, used: 0, helpful: 0, harmful: 0 });
  e[field]++;
  if (ts && field !== "seen") e.lastUsed = ts;
};

/** The first code span of an entry's content, as words: `pnpm vitest run <path>` → ["pnpm", "vitest", "run"]. */
const commandWords = (content: string): string[] =>
  (content.match(/`([^`]+)`/)?.[1] ?? "")
    .split(/\s+/)
    .filter((w) => w && !/^[<[{]/.test(w))
    .slice(0, 3);

const lastStep = (cmd: string): string => (cmd.split(/&&|;/).at(-1) ?? cmd).trim();

/** A command entry counts as used when a task ran a command that starts the way the recorded one does. */
export const commandsUsed = (entries: Entry[], tools: ToolEvent[]): string[] => {
  const ran = tools.filter((t) => t.tool === "Bash" && t.ok && t.target).map((t) => lastStep(t.target!));
  return entries
    .filter((e) => e.type === "command")
    .filter((e) => {
      const words = commandWords(e.content);
      return words.length >= 2 && ran.some((r) => r.startsWith(words.join(" ")));
    })
    .map((e) => e.id);
};

export interface Feedback {
  id: string;
  verdict: "helpful" | "harmful";
}

/** Folds one task's evidence of use into the counters; returns the entries now judged harmful more than helpful. */
export const recordUse = (
  u: UsageMap,
  args: { seen: string[]; used: string[]; feedback: Feedback[]; known: Set<string>; ts: string },
): string[] => {
  for (const id of new Set(args.seen)) if (args.known.has(id)) bump(u, id, "seen");
  for (const id of new Set(args.used)) if (args.known.has(id)) bump(u, id, "used", args.ts);
  for (const f of args.feedback) if (args.known.has(f.id)) bump(u, f.id, f.verdict, args.ts);
  return Object.entries(u)
    .filter(([id, e]) => args.known.has(id) && e.harmful >= 2 && e.harmful > e.helpful)
    .map(([id]) => id);
};

/** Entries no task has used, confirmed or found helpful for `days`, counted from their last sign of life. */
export const unusedFor = (entries: Entry[], u: UsageMap, days: number, now: Date): Entry[] =>
  entries.filter((e) => {
    const last = [u[e.id]?.lastUsed, e.updated, e.created].filter(Boolean).sort().at(-1)!;
    return now.getTime() - new Date(last).getTime() > days * 86_400_000;
  });
