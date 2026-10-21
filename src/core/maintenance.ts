// Keeping the knowledge base honest: is it paying off (stats), what is in it (recall), what has gone quiet (gc),
// what looks wrong (lint). Shared by the CLI and the mod's /archivist command.
import type { Config } from "./config.js";
import { PATHS, type Io } from "./io.js";
import { activeEntries } from "./ledger.js";
import { compareText, loadAnalyses, loadBaseline, loadMetrics, summarize } from "./metrics.js";
import { listProposals, needsHuman } from "./review.js";
import { adrPath, findStale, groupAreas, renderCore } from "./render.js";
import { bm25, jaccard } from "./text.js";
import type { Entry, LedgerRecord } from "./types.js";
import { loadUsage, unusedFor, type UsageMap } from "./usage.js";

/** The latest tasks are what "now" means: old ones measured a knowledge base that has changed since. */
const RECENT = 30;

export const statsText = async (io: Io, entries: Map<string, Entry>): Promise<string> => {
  const live = (await loadMetrics(io)).filter((m) => m.source === "live").slice(-RECENT);
  const baseline = await loadBaseline(io);
  const recent = summarize(live);
  const usage = await loadUsage(io);
  const active = activeEntries(entries);

  const lines = ["# Archivist stats", "", compareText(baseline, recent), ""];

  // The analyzer's own promise, held against what the measures show.
  const promised = active.filter((e) => e.savings && (usage[e.id]?.used ?? 0) > 0);
  if (promised.length) {
    const calls = promised.reduce((s, e) => s + (e.savings!.toolCalls ?? 0) * usage[e.id]!.used, 0);
    const observed = baseline ? Math.round((baseline.summary.medians.toolCalls - recent.medians.toolCalls) * recent.tasks) : undefined;
    lines.push(
      `Estimated by the analyzer for the entries tasks used: ≈ ${calls} tool calls saved.` +
        (observed !== undefined ? ` Observed against the baseline: ≈ ${observed} over ${recent.tasks} tasks.` : ""),
      "",
    );
  }

  const row = (e: Entry) => {
    const u = usage[e.id];
    return `| \`${e.id}\` ${e.title} | ${u?.seen ?? 0} | ${u?.used ?? 0} | ${u?.helpful ?? 0} | ${u?.harmful ?? 0} |`;
  };
  const touched = active.filter((e) => usage[e.id]).sort((a, b) => score(usage, b) - score(usage, a));
  lines.push(`${active.length} active entries; ${touched.length} met in a task, ${active.length - touched.length} never yet.`);
  if (touched.length) lines.push("", "| entry | seen | used | helpful | harmful |", "|---|---|---|---|---|", ...touched.slice(0, 15).map(row));
  const flagged = active.filter((e) => (usage[e.id]?.harmful ?? 0) > (usage[e.id]?.helpful ?? 0));
  if (flagged.length) lines.push("", `Judged wrong more often than helpful: ${flagged.map((e) => `\`${e.id}\``).join(", ")}. See /archivist review.`);
  return lines.join("\n") + "\n";
};

const score = (u: UsageMap, e: Entry): number => (u[e.id]?.used ?? 0) + (u[e.id]?.helpful ?? 0) * 2 - (u[e.id]?.harmful ?? 0) * 2;

/** What the agent can ask instead of exploring: the few entries that match its words. */
export const recallText = (entries: Map<string, Entry>, query: string, k = 5): string => {
  const active = activeEntries(entries);
  const hits = bm25(active.map((e) => `${e.title} ${e.content} ${e.rationale ?? ""} ${e.scope?.paths.join(" ") ?? ""}`), query).slice(0, k);
  if (!hits.length) return `Nothing recorded about "${query}".`;
  return hits
    .map(({ index }) => {
      const e = active[index]!;
      const where = e.type === "decision" ? ` → ${adrPath(e)}` : e.scope ? ` (${e.scope.paths.join(", ")})` : "";
      return `- \`${e.id}\` [${e.type}] ${e.title}: ${e.content.replace(/\s*\n\s*/g, " ")}${where}`;
    })
    .join("\n");
};

/** Entries with no sign of use for `days`: candidates to retire. Decisions are history, so they are left alone. */
export const gcCandidates = async (io: Io, entries: Map<string, Entry>, days: number, now: Date): Promise<Entry[]> =>
  unusedFor(
    activeEntries(entries).filter((e) => e.type !== "decision"),
    await loadUsage(io),
    days,
    now,
  );

export const gcRecords = (stale: Entry[], days: number, ts: string): LedgerRecord[] =>
  stale.map((e) => ({ v: 1, ts, op: "deprecate", id: e.id, reason: `unused for ${days} days` }));

export interface Finding {
  level: "warn" | "info";
  text: string;
}

/** Deterministic checks; nothing here calls a model. */
export const lint = async (io: Io, entries: Map<string, Entry>, config: Config): Promise<Finding[]> => {
  const out: Finding[] = [];
  const active = activeEntries(entries);
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.type !== b.type) continue;
      const sim = jaccard(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
      if (sim >= 0.45) out.push({ level: "warn", text: `\`${a.id}\` and \`${b.id}\` say much the same (${Math.round(sim * 100)}%): merge, or one contradicts the other` });
      else if (a.type === "command" && a.title.toLowerCase() === b.title.toLowerCase())
        out.push({ level: "warn", text: `\`${a.id}\` and \`${b.id}\` are both "${a.title}" with different commands: which one is right?` });
    }
  for (const id of await findStale(io, entries)) out.push({ level: "warn", text: `\`${id}\` is stale: every file it cites is gone` });
  const usage = await loadUsage(io);
  for (const e of active) {
    if (e.type === "decision" && !e.rationale) out.push({ level: "warn", text: `\`${e.id}\` is a decision without a reason` });
    if ((usage[e.id]?.harmful ?? 0) > (usage[e.id]?.helpful ?? 0)) out.push({ level: "warn", text: `\`${e.id}\` was judged wrong more often than helpful` });
    if (!e.evidence.some((v) => v.file) && e.type !== "decision") out.push({ level: "info", text: `\`${e.id}\` cites no file: it cannot go stale when the code changes` });
  }
  const core = renderCore([...entries.values()], config);
  const omitted = core.match(/(\d+) more in `/);
  if (omitted) out.push({ level: "warn", text: `${omitted[1]} entries do not fit in ${PATHS.coreRule} (${config.budgets.coreLines} lines): scope some to paths, or retire some` });
  return out;
};

/** What only the mod knows: its own log (failures, postponements) and today's analysis spend. */
export interface HealthExtras {
  log?: string[];
  spentToday?: number;
}

const WEEK = 7 * 86_400_000;

/**
 * One look at how Archivist is doing in this project: the knowledge base, the last week of analyses, which
 * entries tasks actually meet, what lint finds, and what to do about it. Deterministic: no model call.
 */
export const healthText = async (io: Io, entries: Map<string, Entry>, config: Config, now: Date, extras: HealthExtras = {}): Promise<string> => {
  const since = new Date(now.getTime() - WEEK).toISOString();
  const active = activeEntries(entries);
  const by = (t: string) => active.filter((e) => e.type === t).length;
  const stale = await findStale(io, entries);
  const queue = await listProposals(io);
  const human = queue.filter((p) => needsHuman(p.op)).length;
  const coreText = (await io.read(PATHS.coreRule)) ?? "";
  const coreLines = Math.max(0, coreText.split("\n").length - 1);
  const coreChars = coreText.length;
  const areas = groupAreas(active, stale).size;

  const week = (await loadAnalyses(io)).filter((a) => a.ts >= since);
  const done = week.filter((a) => a.outcome === "done");
  const tasks = (await loadMetrics(io)).filter((m) => m.source === "live" && m.ts >= since).length;
  const errors = week.filter((a) => a.error).length;
  const logWeek = (extras.log ?? []).filter((l) => l.slice(0, 24) >= since);
  const failed = logWeek.filter((l) => l.includes(": failed:")).length;
  const postponed = logWeek.filter((l) => l.includes(": postponed:")).length;
  const recorded = done.reduce((s, a) => s + a.applied, 0);
  const proposed = done.reduce((s, a) => s + a.proposals, 0);
  const spent = week.reduce((s, a) => s + a.tokens, 0);

  const usage = await loadUsage(io);
  const met = active.filter((e) => usage[e.id]).length;
  // Stale entries have their own line: counted once, where the fix is.
  const neverMet = active.filter((e) => e.type !== "decision" && !stale.has(e.id) && !usage[e.id] && e.created < since);
  const wrong = active.filter((e) => (usage[e.id]?.harmful ?? 0) > (usage[e.id]?.helpful ?? 0));
  const warnings = (await lint(io, entries, config)).filter((f) => f.level === "warn");
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

  const lines = [
    "# Archivist health",
    "",
    "## Knowledge",
    `- ${active.length} active entries: ${by("command")} commands, ${by("gotcha")} gotchas, ${by("decision")} decisions, ${by("procedure")} procedures; ${entries.size - active.length} retired; ${stale.size} stale`,
    `- always loaded: ${PATHS.coreRule} ${coreLines}/${config.budgets.coreLines} lines, ${coreChars}/${config.budgets.coreChars} chars (≈ ${Math.round(coreChars / 3)} tokens every session); ${areas} path-scoped rule files`,
    `- review queue: ${queue.length}${human ? ` (${human} decisions or removals wait for you)` : ""}`,
    "",
    "## Last 7 days",
    week.length || !tasks
      ? `- ${tasks} tasks seen; ${week.length} analysed: ${done.length} fully, ${week.length - done.length} skipped as trivial`
      : `- ${tasks} tasks seen; the analysis journal starts with Archivist 1.3.0, so these counts fill in from the next analysed task`,
    `- recorded ${recorded} entries, proposed ${proposed}; analysis cost ${k(spent)} weighted tokens${extras.spentToday !== undefined ? ` (today ${k(extras.spentToday)} of ${k(config.analyzer.maxTokensPerDay)})` : ""}`,
    `- problems: ${errors} analyses with model errors${extras.log ? `, ${failed} failed, ${postponed} postponed` : ""}`,
    "",
    "## Entries in use",
    `- ${met} of ${active.length} met in a task (rule loaded, command run, or confirmed)`,
    ...(neverMet.length ? [`- never met, older than a week: ${neverMet.slice(0, 5).map((e) => `\`${e.id}\` ${e.title}`).join("; ")}${neverMet.length > 5 ? ` and ${neverMet.length - 5} more` : ""}`] : []),
    ...(wrong.length ? [`- judged wrong more often than helpful: ${wrong.map((e) => `\`${e.id}\``).join(", ")}`] : []),
  ];
  if (warnings.length) lines.push("", "## Lint", ...warnings.slice(0, 10).map((w) => `- ${w.text}`), ...(warnings.length > 10 ? [`- and ${warnings.length - 10} more: archivist lint`] : []));

  const todo: string[] = [];
  if (human || queue.length >= 5) todo.push(`/archivist:triage: ${queue.length} proposals${human ? `, ${human} of them need your yes or no` : ""}`);
  if (failed || errors) todo.push("/archivist log: some analyses failed; send the log if it keeps happening");
  if (stale.size) todo.push(`${stale.size} stale entries: /archivist edit or /archivist deprecate (see ${PATHS.index})`);
  if (neverMet.length >= 3) todo.push(`${neverMet.length} entries never met in a week: archivist gc --days 7 lists them, --apply retires them`);
  if (warnings.some((w) => !w.text.includes("stale") && !w.text.includes("judged wrong"))) todo.push("lint findings above: merge or fix them with /archivist edit or /archivist deprecate");
  if (coreLines > config.budgets.coreLines * 0.9 || coreChars > config.budgets.coreChars * 0.9) todo.push(`${PATHS.coreRule} is near its budget: scope entries to paths (/archivist edit <id> --paths "…")`);
  // Judged only on a week the journal covers: before 1.3.0 there is no journal, and silence would read as failure.
  if (week.length >= 5 && !done.some((a) => a.applied || a.proposals)) todo.push("nothing recorded in a week of tasks: the thresholds may be too strict (analyzer.minToolCalls, apply.autoConfidence)");
  if (!(await loadBaseline(io))) todo.push("no baseline yet: archivist baseline, so /archivist stats can show the effect");
  lines.push("", "## What to do", ...(todo.length ? todo.map((t) => `- ${t}`) : ["- Nothing: Archivist is doing fine here."]));
  return lines.join("\n") + "\n";
};
