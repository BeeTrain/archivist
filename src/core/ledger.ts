import { PATHS, type Io } from "./io.js";
import type { Entry, EntryType, LedgerRecord } from "./types.js";

export interface KnowledgeState {
  entries: Map<string, Entry>;
  /** Lines that did not parse (kept out of the state, reported by doctor). */
  badLines: number[];
}

export const parseLedger = (text: string): { records: LedgerRecord[]; badLines: number[] } => {
  const records: LedgerRecord[] = [];
  const badLines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line) as LedgerRecord;
      if (r && r.v === 1 && typeof r.op === "string") records.push(r);
      else badLines.push(i + 1);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { records, badLines };
};

/** Folds records into the current state. Deterministic: same ledger, same state. */
export const foldLedger = (records: LedgerRecord[]): Map<string, Entry> => {
  const entries = new Map<string, Entry>();
  for (const r of records) {
    if (r.op === "add") {
      entries.set(r.entry.id, { ...r.entry });
      for (const old of r.entry.supersedes ?? []) {
        const e = entries.get(old);
        if (e && e.status === "active") entries.set(old, { ...e, status: "deprecated", deprecatedReason: `superseded by ${r.entry.id}`, updated: r.ts });
      }
      continue;
    }
    const e = entries.get(r.id);
    if (!e) continue;
    if (r.op === "update") entries.set(r.id, { ...e, ...r.patch, updated: r.ts });
    else if (r.op === "deprecate") entries.set(r.id, { ...e, status: "deprecated", deprecatedReason: r.reason, updated: r.ts });
    else if (r.op === "reinforce") entries.set(r.id, { ...e, reinforced: e.reinforced + 1 });
  }
  return entries;
};

export const loadState = async (io: Io): Promise<KnowledgeState> => {
  const text = (await io.read(PATHS.ledger)) ?? "";
  const { records, badLines } = parseLedger(text);
  return { entries: foldLedger(records), badLines };
};

/** Appends records. Callers hold the analysis lock, so there is one writer. */
export const appendLedger = async (io: Io, records: LedgerRecord[]): Promise<void> => {
  if (!records.length) return;
  const prev = (await io.read(PATHS.ledger)) ?? "";
  const sep = prev && !prev.endsWith("\n") ? "\n" : "";
  await io.write(PATHS.ledger, prev + sep + records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

const PREFIX: Record<EntryType, string> = { command: "cmd", gotcha: "gk", decision: "dec" };

export const newId = (type: EntryType, taken: Set<string>): string => {
  for (;;) {
    const id = `${PREFIX[type]}-${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
};

export const nextAdr = (entries: Iterable<Entry>): number => {
  let max = 0;
  for (const e of entries) if (e.adr && e.adr > max) max = e.adr;
  return max + 1;
};

export const activeEntries = (entries: Map<string, Entry>): Entry[] => [...entries.values()].filter((e) => e.status === "active");
