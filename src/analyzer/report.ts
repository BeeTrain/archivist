import type { Outcome } from "../core/validate.js";
import type { Usage } from "../core/types.js";
import type { Signals } from "./signals.js";

export interface Report {
  ts: string;
  session: string;
  segment: string;
  title: string;
  summary: string;
  signals: Signals;
  applied: Outcome[];
  proposals: Outcome[];
  rejected: Outcome[];
  written: string[];
  analysis: { reflect?: Usage; curate?: Usage; notesKind: "reflection" | "digest"; note?: string; error?: string };
}

const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const mark: Record<string, string> = { add: "+", update: "~", reinforce: "↑", deprecate: "−" };

const outcomeLine = (o: Outcome): string =>
  `${mark[o.op.op] ?? "?"} [${o.type ?? "?"}] ${o.title ?? ""}${o.id ? ` \`${o.id}\`` : ""}${o.reason ? ` — ${o.reason}` : ""}`;

const savings = (r: Report): { toolCalls: number; tokens: number } => {
  let toolCalls = 0;
  let tokens = 0;
  for (const o of r.applied) {
    const s = "savings" in o.op ? o.op.savings : undefined;
    toolCalls += s?.toolCalls ?? 0;
    tokens += s?.tokens ?? 0;
  }
  return { toolCalls, tokens };
};

/** One line for the status bar: always visible, so short. */
export const statusLine = (r: Report): string => {
  const added = r.applied.filter((o) => o.op.op !== "reinforce").length;
  const parts = [added ? `+${added} ${added === 1 ? "entry" : "entries"}` : "nothing new"];
  if (r.proposals.length) parts.push(`${r.proposals.length} to review`);
  parts.push("/archivist");
  return `📚 ${parts.join(" · ")}`;
};

export const reportMarkdown = (r: Report): string => {
  const s = r.signals;
  const u = s.usage;
  const sv = savings(r);
  const lines = [
    `# Archivist · ${r.title}`,
    "",
    `${r.ts} · session \`${r.session.slice(0, 8)}\` · ${s.turns} turns · ${Math.round(s.durationMs / 1000)} s · ` +
      `tokens in ${k(u.input + u.cacheRead + u.cacheWrite)} (cached ${k(u.cacheRead)}) / out ${k(u.output)} · ` +
      `${s.toolCalls} tool calls · ${s.readsBeforeFirstEdit} reads before first edit`,
    "",
    r.summary ? `**Takeaway:** ${r.summary}` : "",
    "",
    "## Added and changed",
    "",
    ...(r.applied.length ? r.applied.map(outcomeLine) : ["Nothing: this task taught nothing durable."]),
  ];
  if (r.proposals.length) lines.push("", "## Waiting for review", "", ...r.proposals.map(outcomeLine));
  if (r.rejected.length) lines.push("", "## Dropped", "", ...r.rejected.map(outcomeLine));
  if (sv.toolCalls || sv.tokens) lines.push("", `**Expected savings on a similar task:** ≈ ${sv.toolCalls} tool calls, ≈ ${k(sv.tokens)} tokens.`);
  if (r.written.length) lines.push("", "## Files", "", ...r.written.map((w) => `- \`${w}\``));
  const a = r.analysis;
  const cost = [a.reflect && `reflect in ${k(a.reflect.input + a.reflect.cacheRead)}/out ${k(a.reflect.output)}`, a.curate && `curate in ${k(a.curate.input)}/out ${k(a.curate.output)}`]
    .filter(Boolean)
    .join(", ");
  lines.push("", `_Analysis: ${a.notesKind}${cost ? `; ${cost}` : ""}${a.note ? `; ${a.note}` : ""}${a.error ? `; error: ${a.error}` : ""}_`, "");
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
};

/** The notice under the next answer: a few lines, the full report is one command away. */
export const noticeText = (r: Report): string => {
  const head = statusLine(r);
  const items = r.applied.filter((o) => o.op.op !== "reinforce").slice(0, 4).map(outcomeLine);
  return [head, ...items].join("\n");
};
