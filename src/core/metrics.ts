// Per-task metrics: what a task cost and how much it wandered. Kept locally, compared against a baseline
// taken from sessions before Archivist, to tell whether the recorded knowledge actually saves anything.
import type { Io } from "./io.js";
import { weightedTokens, type Usage } from "./types.js";

export const METRICS = ".archivist/.local/metrics.jsonl";
export const BASELINE = ".archivist/.local/baseline.json";
/** One line per analysis run: what came of it and what it cost. What `health` counts. */
export const ANALYSES = ".archivist/.local/analyses.jsonl";

export interface AnalysisRecord {
  ts: string;
  segment?: string;
  outcome: "done" | "skipped";
  applied: number;
  proposals: number;
  dropped: number;
  /** Weighted tokens the analysis itself spent (cache reads count 0.1×). */
  tokens: number;
  error?: string;
}

export const appendAnalysis = async (io: Io, r: AnalysisRecord): Promise<void> => {
  const prev = (await io.read(ANALYSES)) ?? "";
  await io.write(ANALYSES, prev + JSON.stringify(r) + "\n");
};

export const loadAnalyses = async (io: Io): Promise<AnalysisRecord[]> =>
  ((await io.read(ANALYSES)) ?? "").split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l) as AnalysisRecord] : [];
    } catch {
      return [];
    }
  });

export interface TaskMetrics {
  ts: string;
  segment?: string;
  source: "live" | "baseline";
  turns: number;
  durationMs: number;
  /** Weighted tokens: cache reads count 0.1×. */
  tokens: number;
  usage: Usage;
  toolCalls: number;
  edits: number;
  readsBeforeFirstEdit: number;
  repeatedReads: number;
  failedCommands: number;
  corrections: number;
  /** Archivist rule files loaded during the task. */
  rulesLoaded: number;
}

export const toMetrics = (
  s: {
    turns: number;
    durationMs: number;
    usage: Usage;
    toolCalls: number;
    edits: string[];
    readsBeforeFirstEdit: number;
    repeatedReads: unknown[];
    failedCommands: unknown[];
    corrections: unknown[];
    rulesLoaded: unknown[];
  },
  ts: string,
  source: TaskMetrics["source"],
): TaskMetrics => ({
  ts,
  source,
  turns: s.turns,
  durationMs: s.durationMs,
  tokens: weightedTokens(s.usage),
  usage: s.usage,
  toolCalls: s.toolCalls,
  edits: s.edits.length,
  readsBeforeFirstEdit: s.readsBeforeFirstEdit,
  repeatedReads: s.repeatedReads.length,
  failedCommands: s.failedCommands.length,
  corrections: s.corrections.length,
  rulesLoaded: s.rulesLoaded.length,
});

export const appendMetrics = async (io: Io, m: TaskMetrics): Promise<void> => {
  const prev = (await io.read(METRICS)) ?? "";
  await io.write(METRICS, prev + JSON.stringify(m) + "\n");
};

export const loadMetrics = async (io: Io): Promise<TaskMetrics[]> =>
  ((await io.read(METRICS)) ?? "").split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l) as TaskMetrics] : [];
    } catch {
      return [];
    }
  });

/** The measures compared, chosen to be comparable across tasks of different sizes: medians, not sums. */
export const MEASURES = [
  ["tokens", "weighted tokens"],
  ["toolCalls", "tool calls"],
  ["readsBeforeFirstEdit", "reads before first edit"],
  ["repeatedReads", "files re-read"],
  ["failedCommands", "failed commands"],
  ["durationMs", "duration, s"],
] as const satisfies readonly (readonly [keyof TaskMetrics, string])[];

export type Measure = (typeof MEASURES)[number][0];

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface Summary {
  tasks: number;
  medians: Record<Measure, number>;
}

/** Only tasks that did something: trivial ones would drag every median towards zero. */
export const summarize = (ms: TaskMetrics[]): Summary => {
  const real = ms.filter((m) => m.toolCalls > 0);
  const medians = Object.fromEntries(MEASURES.map(([k]) => [k, median(real.map((m) => m[k] as number))])) as Record<Measure, number>;
  return { tasks: real.length, medians };
};

export interface Baseline {
  createdAt: string;
  /** Sessions taken into account: the ones before this date. */
  before: string;
  sessions: number;
  summary: Summary;
}

export const loadBaseline = async (io: Io): Promise<Baseline | undefined> => {
  try {
    return JSON.parse((await io.read(BASELINE)) ?? "") as Baseline;
  } catch {
    return undefined;
  }
};

const fmt = (k: Measure, v: number): string =>
  k === "durationMs" ? String(Math.round(v / 1000)) : k === "tokens" ? (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))) : String(Math.round(v * 10) / 10);

/** A table of medians, baseline against recent tasks, with the change in percent. */
export const compareText = (baseline: Baseline | undefined, recent: Summary): string => {
  const lines: string[] = [];
  if (!baseline) {
    lines.push("No baseline yet: run `archivist baseline` to measure the sessions before Archivist.", "");
  }
  lines.push(baseline ? `| measure (median per task) | before (${baseline.summary.tasks} tasks) | now (${recent.tasks} tasks) | change |` : `| measure (median per task) | now (${recent.tasks} tasks) |`);
  lines.push(baseline ? "|---|---|---|---|" : "|---|---|");
  for (const [k, label] of MEASURES) {
    const now = recent.medians[k];
    if (!baseline) {
      lines.push(`| ${label} | ${fmt(k, now)} |`);
      continue;
    }
    const before = baseline.summary.medians[k];
    const change = before && recent.tasks ? `${now <= before ? "−" : "+"}${Math.round((Math.abs(now - before) / before) * 100)}%` : "—";
    lines.push(`| ${label} | ${fmt(k, before)} | ${fmt(k, now)} | ${change} |`);
  }
  if (!recent.tasks) lines.push("", "No task measured since Archivist started: the comparison comes with the first analysed tasks.");
  else if (baseline && (baseline.summary.tasks < 5 || recent.tasks < 5)) lines.push("", "Fewer than 5 tasks on one side: the change is noise until there are more.");
  return lines.join("\n");
};
