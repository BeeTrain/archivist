// The human side: review the analyzer's doubtful proposals, and record facts by hand.
import type { Config } from "./config.js";
import { PATHS, joinPath, type Io } from "./io.js";
import { appendLedger, loadState } from "./ledger.js";
import { renderAll } from "./render.js";
import { ENTRY_TYPES, type EntryType, type ProposedOp, type RecordSource } from "./types.js";
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
