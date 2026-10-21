// Keeping the knowledge base honest: is it paying off (stats), what is in it (recall), what has gone quiet (gc),
// what looks wrong (lint). Shared by the CLI and the mod's /archivist command.
import type { Config } from "./config.js";
import { PATHS, type Io } from "./io.js";
import { activeEntries } from "./ledger.js";
import { compareText, loadBaseline, loadMetrics, summarize } from "./metrics.js";
import { adrPath, findStale, renderCore } from "./render.js";
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
