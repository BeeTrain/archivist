// Segment → signals → (gate) → reflect → curate → validate → ledger → views → report.
import type { Config } from "../core/config.js";
import { PATHS, joinPath, type Io, type Llm } from "../core/io.js";
import { activeEntries, appendLedger, loadState } from "../core/ledger.js";
import { redact } from "../core/privacy.js";
import { renderAll } from "../core/render.js";
import { loadSkipped } from "../core/review.js";
import { bm25, globToRegExp, truncate } from "../core/text.js";
import { addUsage, emptyUsage, type Entry, type Message, type Segment, type Usage } from "../core/types.js";
import { validateOps } from "../core/validate.js";
import { digestFromMessages, digestFromSegment, sliceTask } from "./digest.js";
import { parseCuratorReply } from "./parse.js";
import { CURATE_SYSTEM, curatePrompt, reflectPrompt } from "./prompts.js";
import { reportMarkdown, type Report } from "./report.js";
import { computeSignals, isTrivial, signalsText } from "./signals.js";

const DOCS = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "README.md", "CLAUDE.local.md"];
const TOP_K = 15;

export type AnalysisResult =
  | { kind: "skipped"; reason: string; usage: Usage }
  | { kind: "done"; report: Report; reportPath: string; usage: Usage };

const toUsage = (u: Partial<Usage> | undefined): Usage => addUsage(emptyUsage(), u ?? {});

/** Entries the curator should see: scoped to edited files, plus BM25 over the task's words. Never the whole base. */
export const pickCandidates = (entries: Entry[], seg: Segment, edits: string[], k = TOP_K): Entry[] => {
  const scoped = entries.filter((e) => e.scope?.paths.some((g) => edits.some((f) => globToRegExp(g).test(f))));
  const query = [...seg.prompts, ...edits, ...seg.tools.map((t) => t.target ?? "")].join(" ");
  const ranked = bm25(entries.map((e) => `${e.title} ${e.content} ${e.scope?.paths.join(" ") ?? ""}`), query).map((r) => entries[r.index]!);
  const out: Entry[] = [];
  for (const e of [...scoped, ...ranked]) if (!out.includes(e) && out.length < k) out.push(e);
  return out;
};

const readDocs = async (io: Io): Promise<string[]> => {
  const out: string[] = [];
  for (const p of DOCS) {
    const t = await io.read(p);
    if (t) out.push(t.slice(0, 50_000));
  }
  return out;
};

export const analyzeSegment = async (args: {
  io: Io;
  llm: Llm;
  config: Config;
  segment: Segment;
  /** The session's messages, when the adapter can read them; else the journal is all there is. */
  messages?: Message[];
  /** Tokens in the live context: above `forkMaxContextTokens` the reflection costs more than it is worth. */
  contextTokens?: number;
  now: Date;
}): Promise<AnalysisResult> => {
  const { io, llm, config, segment: seg, now } = args;
  const signals = computeSignals(seg);
  let usage = emptyUsage();
  if (isTrivial(signals, config)) return { kind: "skipped", reason: "trivial task", usage };

  const state = await loadState(io);
  const active = activeEntries(state.entries);
  const candidates = pickCandidates(active, seg, signals.edits);

  // 1. Notes: the agent's own reflection over its cached context, or a digest for the cheap model.
  let notes = "";
  let notesKind: "reflection" | "digest" = "digest";
  let reflectUsage: Usage | undefined;
  let error: string | undefined;
  const tooBig = (args.contextTokens ?? 0) > config.analyzer.forkMaxContextTokens;
  const note = tooBig ? `reflect skipped: context ${args.contextTokens} tokens > ${config.analyzer.forkMaxContextTokens}` : undefined;
  if (config.analyzer.reflect === "fork" && llm.reflect && args.messages && !tooBig) {
    const r = await llm.reflect(reflectPrompt(seg.prompts[0], config.language));
    reflectUsage = toUsage(r.usage);
    usage = addUsage(usage, reflectUsage);
    if (r.ok && r.text.trim()) {
      notes = r.text.trim();
      notesKind = "reflection";
    } else if (!r.ok) error = `reflect: ${r.reason}`;
  }
  if (!notes) notes = args.messages ? digestFromMessages(sliceTask(args.messages, seg.prompts[0])) : digestFromSegment(seg);
  // Whatever the task touched may hold secrets: they never reach the curator, so never an entry.
  notes = redact(notes).text;

  // 2. Curate: notes → ops against the relevant existing entries.
  const c = await llm.complete({ system: CURATE_SYSTEM, prompt: curatePrompt({ notes, notesKind, signals: signalsText(signals), candidates, language: config.language }), maxTokens: 2500 });
  const curateUsage = toUsage(c.usage);
  usage = addUsage(usage, curateUsage);
  const reply = c.ok ? parseCuratorReply(c.text) : undefined;
  if (!c.ok) error = [error, `curate: ${c.reason}`].filter(Boolean).join("; ");
  else if (!reply) error = [error, "curate: reply was not JSON"].filter(Boolean).join("; ");

  // 3. Validate, apply, render.
  const ts = now.toISOString();
  const src = { segment: seg.id };
  const v = await validateOps({ ops: reply?.ops ?? [], entries: state.entries, io, config, docs: await readDocs(io), now: ts, src, skipped: await loadSkipped(io) });
  await appendLedger(io, v.records);
  const { written, removed } = await renderAll(io, (await loadState(io)).entries, config);
  written.push(...removed.map((r) => `${r} (removed)`));
  for (const [i, p] of v.proposals.entries()) {
    const path = joinPath(PATHS.proposals, `${ts.replace(/[:.]/g, "-")}-${i}.json`);
    await io.write(path, JSON.stringify({ ts, src, op: p.op, reason: p.reason ?? null }, null, 2) + "\n");
    written.push(path);
  }

  const report: Report = {
    ts,
    session: seg.session,
    segment: seg.id,
    title: truncate((seg.prompts[0] ?? "task").replace(/\s+/g, " "), 80),
    summary: reply?.summary ?? "",
    signals,
    applied: v.applied,
    proposals: v.proposals,
    rejected: v.rejected,
    written,
    analysis: { notesKind, ...(reflectUsage ? { reflect: reflectUsage } : {}), curate: curateUsage, ...(note ? { note } : {}), ...(error ? { error } : {}) },
  };
  const reportPath = joinPath(PATHS.reports, `${ts.replace(/[:.]/g, "-")}.md`);
  await io.write(reportPath, reportMarkdown(report));
  return { kind: "done", report, reportPath, usage };
};
