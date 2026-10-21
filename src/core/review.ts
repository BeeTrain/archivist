// The human side: review the analyzer's doubtful proposals, and record facts by hand.
import type { Config } from "./config.js";
import { PATHS, joinPath, type Io } from "./io.js";
import { commaList } from "./args.js";
import { appendLedger, loadState } from "./ledger.js";
import { redact } from "./privacy.js";
import { truncate } from "./text.js";
import { renderAll } from "./render.js";
import { ENTRY_TYPES, type Entry, type EntryPatch, type EntryType, type ProposedOp, type RecordSource } from "./types.js";
import { validateOps, type Outcome } from "./validate.js";

export interface Proposal {
  /** 1-based, in the order `review` lists them. */
  n: number;
  path: string;
  op: ProposedOp;
  reason: string | null;
  src?: RecordSource;
}

const SKIPPED = ".archivist/.local/skipped.jsonl";

export const listProposals = async (io: Io): Promise<Proposal[]> => {
  const names = (await io.list(PATHS.proposals)).filter((n) => n.endsWith(".json")).sort();
  const out: Proposal[] = [];
  for (const name of names) {
    const path = joinPath(PATHS.proposals, name);
    try {
      const p = JSON.parse((await io.read(path)) ?? "") as { op: ProposedOp; reason?: string | null; src?: RecordSource };
      out.push({ n: out.length + 1, path, op: p.op, reason: p.reason ?? null, ...(p.src ? { src: p.src } : {}) });
    } catch {
      /* unreadable file: doctor reports it */
    }
  }
  return out;
};

export const describeOp = (op: ProposedOp): string => {
  if (op.op === "add") return `+ [${op.type}] ${op.title}: ${op.content}${op.rationale ? ` (why: ${op.rationale})` : ""}`;
  if (op.op === "update") return `~ ${op.id}: ${op.content ?? op.title ?? ""}`;
  if (op.op === "deprecate") return `− ${op.id}: ${op.reason}`;
  return `↑ ${op.id}`;
};

export const reviewText = (proposals: Proposal[]): string =>
  proposals.length
    ? [
        `${proposals.length} proposal(s) waiting for review:`,
        ...proposals.map((p) => `${p.n}. ${describeOp(p.op)}${p.reason ? `  — ${p.reason}` : ""}`),
        "",
        "apply <n|all> records a proposal as is; skip <n|all> drops it and keeps the idea from coming back.",
        `To edit before applying, change the op in its file under ${PATHS.proposals}/ and apply it.`,
      ].join("\n")
    : "No proposals waiting for review.";

/** Picks proposals by `n`, a list `1,3` or `all`. */
export const pick = (proposals: Proposal[], which: string): Proposal[] => {
  if (which.trim() === "all") return proposals;
  const ns = new Set(which.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n)));
  return proposals.filter((p) => ns.has(p.n));
};

/** The user's word is the confidence: what they approve or write is applied, past the auto thresholds. */
const asUser = (config: Config): Config => ({ ...config, apply: { autoConfidence: 0, autoTypes: [...ENTRY_TYPES] } });

const record = async (io: Io, config: Config, ops: ProposedOp[], now: string, src?: RecordSource): Promise<Outcome[]> => {
  const state = await loadState(io);
  const v = await validateOps({ ops, entries: state.entries, io, config: asUser(config), docs: [], now, source: "user", ...(src ? { src } : {}) });
  await appendLedger(io, v.records);
  await renderAll(io, (await loadState(io)).entries, config);
  return [...v.applied, ...v.rejected];
};

export const applyProposals = async (io: Io, config: Config, chosen: Proposal[], now: string): Promise<Outcome[]> => {
  const outcomes: Outcome[] = [];
  for (const p of chosen) {
    outcomes.push(...(await record(io, config, [{ ...p.op, confidence: 1 } as ProposedOp], now, p.src)));
    await io.remove?.(p.path);
  }
  return outcomes;
};

export const skipProposals = async (io: Io, chosen: Proposal[], now: string): Promise<number> => {
  const prev = (await io.read(SKIPPED)) ?? "";
  const lines = chosen.map((p) => JSON.stringify({ ts: now, text: p.op.op === "add" ? `${p.op.title} ${p.op.content}` : describeOp(p.op) }));
  if (lines.length) await io.write(SKIPPED, prev + lines.join("\n") + "\n");
  for (const p of chosen) await io.remove?.(p.path);
  return chosen.length;
};

export const loadSkipped = async (io: Io): Promise<string[]> =>
  ((await io.read(SKIPPED)) ?? "")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [String((JSON.parse(l) as { text: string }).text)];
      } catch {
        return [];
      }
    });

/** A fact recorded by hand (`archivist add`, the remember and decide skills). */
export const addEntry = async (
  io: Io,
  config: Config,
  fields: { type: EntryType; title: string; content: string; rationale?: string; paths?: string[]; evidence?: string[] },
  now: string,
): Promise<Outcome[]> =>
  record(
    io,
    config,
    [
      {
        op: "add",
        type: fields.type,
        title: fields.title,
        content: fields.content,
        ...(fields.rationale ? { rationale: fields.rationale } : {}),
        ...(fields.paths?.length ? { scope: { paths: fields.paths } } : {}),
        ...(fields.evidence?.length ? { evidence: fields.evidence.map((file) => ({ file })) } : {}),
        confidence: 1,
      },
    ],
    now,
  );

export interface EntryEdit {
  title?: string;
  content?: string;
  rationale?: string;
  /** New scope; an empty list makes the entry apply everywhere again. */
  paths?: string[];
}

type Changed = { ok: true; entry: Entry; written: string[] } | { ok: false; reason: string };

/** `--title`, `--content`, `--why`, `--paths` as an edit; a bare or empty `--paths` clears the scope. */
export const editFromOptions = (o: Record<string, string>): EntryEdit => ({
  ...(o.title ? { title: o.title } : {}),
  ...(o.content ? { content: o.content } : {}),
  ...(o.why ? { rationale: o.why } : {}),
  ...("paths" in o ? { paths: commaList(o.paths === "true" ? "" : o.paths) } : {}),
});

const activeEntry = async (io: Io, id: string): Promise<Entry | undefined> => {
  const e = (await loadState(io)).entries.get(id);
  return e && e.status === "active" ? e : undefined;
};

/** Fixes an entry in place: the ledger gets an update, the rule files are rendered again. */
export const editEntry = async (io: Io, config: Config, id: string, edit: EntryEdit, now: string): Promise<Changed> => {
  const e = await activeEntry(io, id);
  if (!e) return { ok: false, reason: `no active entry ${id}` };
  const max = e.type === "procedure" ? 1500 : config.budgets.maxContentChars;
  const clean = (s: string, n: number) => redact(truncate(s.trim(), n)).text;
  const patch: EntryPatch = {};
  if (edit.title?.trim() && edit.title.trim() !== e.title) patch.title = clean(edit.title, 120);
  if (edit.content?.trim() && edit.content.trim() !== e.content) patch.content = clean(edit.content, max);
  if (edit.rationale?.trim() && edit.rationale.trim() !== e.rationale) patch.rationale = clean(edit.rationale, max);
  if (edit.paths && edit.paths.join("\n") !== (e.scope?.paths ?? []).join("\n")) patch.scope = { paths: edit.paths };
  if (!Object.keys(patch).length) return { ok: false, reason: "nothing to change" };
  await appendLedger(io, [{ v: 1, ts: now, op: "update", id, patch }]);
  const after = await loadState(io);
  const r = await renderAll(io, after.entries, config);
  return { ok: true, entry: after.entries.get(id)!, written: [...r.written, ...r.removed] };
};

/** Retires an entry: it leaves the rule files and stays in the ledger with the reason. */
export const deprecateEntry = async (io: Io, config: Config, id: string, reason: string, now: string): Promise<Changed> => {
  const e = await activeEntry(io, id);
  if (!e) return { ok: false, reason: `no active entry ${id}` };
  if (!reason.trim()) return { ok: false, reason: "say why: --reason" };
  await appendLedger(io, [{ v: 1, ts: now, op: "deprecate", id, reason: redact(reason.trim()).text }]);
  const after = await loadState(io);
  const r = await renderAll(io, after.entries, config);
  return { ok: true, entry: after.entries.get(id)!, written: [...r.written, ...r.removed] };
};
