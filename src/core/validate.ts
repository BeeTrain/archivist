import type { Config } from "./config.js";
import type { Io } from "./io.js";
import { newId, nextAdr } from "./ledger.js";
import { isExcluded, redact } from "./privacy.js";
import { jaccard, truncate } from "./text.js";
import { ENTRY_TYPES, type Entry, type EntrySource, type EntryType, type LedgerRecord, type ProposedOp, type RecordSource } from "./types.js";

export interface Outcome {
  op: ProposedOp;
  reason?: string;
  /** Entry the op created or touched. */
  id?: string;
  type?: EntryType;
  title?: string;
}

export interface Validated {
  records: LedgerRecord[];
  applied: Outcome[];
  proposals: Outcome[];
  rejected: Outcome[];
}

/** Same type and this similar → it is the same fact: reinforce instead of adding. */
const DUP_ENTRY = 0.6;
/** This similar to a paragraph of existing docs → already documented, adding it only costs context. */
const DUP_DOC = 0.6;

const clamp01 = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const docParagraphs = (docs: string[]): string[] =>
  docs.flatMap((d) => d.split(/\n\s*\n|\n(?=[-*] )/)).map((p) => p.trim()).filter((p) => p.length > 20);

export const validateOps = async (args: {
  ops: ProposedOp[];
  entries: Map<string, Entry>;
  io: Io;
  config: Config;
  /** Texts of docs the agent already gets (CLAUDE.md, AGENTS.md, README…), for dedupe. */
  docs: string[];
  now: string;
  src?: RecordSource;
  source?: EntrySource;
  /** Texts of proposals the user skipped: the same idea is not proposed again. */
  skipped?: string[];
}): Promise<Validated> => {
  const { ops, entries, io, config, now, src } = args;
  const out: Validated = { records: [], applied: [], proposals: [], rejected: [] };
  const paragraphs = docParagraphs(args.docs);
  const taken = new Set(entries.keys());
  let adr = nextAdr(entries.values());
  const touched = new Set<string>();

  const active = (id: string): Entry | undefined => {
    const e = entries.get(id);
    return e && e.status === "active" ? e : undefined;
  };
  const route = (confidence: number, type: EntryType): "apply" | "propose" =>
    confidence >= config.apply.autoConfidence && config.apply.autoTypes.includes(type) ? "apply" : "propose";

  for (const raw of ops) {
    const op = raw as ProposedOp;
    if (!op || typeof op !== "object" || !("op" in op)) {
      out.rejected.push({ op, reason: "not an op" });
      continue;
    }

    if (op.op === "add") {
      if (!ENTRY_TYPES.includes(op.type)) {
        out.rejected.push({ op, reason: `unknown type ${String(op.type)}` });
        continue;
      }
      const t = redact(truncate(String(op.title ?? "").trim(), 120));
      const c = redact(truncate(String(op.content ?? "").trim(), config.budgets.maxContentChars));
      const r = op.rationale ? redact(truncate(String(op.rationale).trim(), config.budgets.maxContentChars)) : undefined;
      const title = t.text;
      const content = c.text;
      if (!title || !content) {
        out.rejected.push({ op, reason: "empty title or content" });
        continue;
      }
      let confidence = clamp01(op.confidence);
      const notes: string[] = [];
      if (t.count + c.count + (r?.count ?? 0)) {
        // A fact that needed a secret to state it is worth a human look before it lands in the repo.
        confidence = Math.min(confidence, config.apply.autoConfidence - 0.01);
        notes.push("secrets redacted");
      }
      if ((args.skipped ?? []).some((s) => jaccard(s, `${title} ${content}`) >= DUP_ENTRY)) {
        out.rejected.push({ op, reason: "skipped in an earlier review" });
        continue;
      }

      const dup = [...entries.values()].find(
        (e) => e.status === "active" && e.type === op.type && jaccard(`${e.title} ${e.content}`, `${title} ${content}`) >= DUP_ENTRY,
      );
      if (dup) {
        if (!touched.has(dup.id)) {
          touched.add(dup.id);
          out.records.push({ v: 1, ts: now, op: "reinforce", id: dup.id, src });
          out.applied.push({ op: { op: "reinforce", id: dup.id }, id: dup.id, type: dup.type, title: dup.title, reason: "duplicate of existing entry" });
        }
        continue;
      }
      if (paragraphs.some((p) => jaccard(p, `${title} ${content}`) >= DUP_DOC)) {
        out.rejected.push({ op, reason: "already in project docs" });
        continue;
      }

      const evidence = [];
      for (const ev of op.evidence ?? []) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.file && isExcluded(ev.file, config.privacy.excludePaths)) continue;
        if (ev.file && !(await io.exists(ev.file))) {
          notes.push(`evidence file not found: ${ev.file}`);
          continue;
        }
        evidence.push({ ...(ev.file ? { file: ev.file } : {}), ...(ev.anchor ? { anchor: String(ev.anchor) } : {}) });
      }
      if ((op.evidence?.some((e) => e?.file) ?? false) && !evidence.some((e) => e.file)) confidence -= 0.3;
      if (op.type === "decision" && !op.rationale) {
        confidence = Math.min(confidence, config.apply.autoConfidence - 0.01);
        notes.push("decision without rationale");
      }
      const supersedes = (op.supersedes ?? []).filter((id) => active(id));

      const id = newId(op.type, taken);
      taken.add(id);
      const entry: Entry = {
        id,
        type: op.type,
        title,
        content,
        ...(r ? { rationale: r.text } : {}),
        ...(op.scope?.paths?.length ? { scope: { paths: op.scope.paths.map(String) } } : {}),
        evidence,
        status: "active",
        confidence: clamp01(confidence),
        source: args.source ?? "analyzer",
        created: now,
        updated: now,
        ...(op.type === "decision" ? { adr: adr } : {}),
        ...(supersedes.length ? { supersedes } : {}),
        reinforced: 0,
      };
      const o: Outcome = { op, id, type: op.type, title, ...(notes.length ? { reason: notes.join("; ") } : {}) };
      if (route(entry.confidence, op.type) === "apply") {
        if (op.type === "decision") adr++;
        out.records.push({ v: 1, ts: now, op: "add", entry, src });
        out.applied.push(o);
      } else {
        delete entry.adr;
        out.proposals.push({ ...o, op: { ...op, title, content } });
      }
      continue;
    }

    const target = "id" in op ? active(op.id) : undefined;
    if (!target) {
      out.rejected.push({ op, reason: `no active entry ${"id" in op ? op.id : "?"}` });
      continue;
    }
    if (touched.has(target.id)) continue;
    touched.add(target.id);
    const base: Outcome = { op, id: target.id, type: target.type, title: target.title };

    if (op.op === "reinforce") {
      out.records.push({ v: 1, ts: now, op: "reinforce", id: target.id, src });
      out.applied.push(base);
    } else if (op.op === "update") {
      const clean = (s: string, max: number) => redact(truncate(s.trim(), max)).text;
      const patch = {
        ...(op.title ? { title: clean(op.title, 120) } : {}),
        ...(op.content ? { content: clean(op.content, config.budgets.maxContentChars) } : {}),
        ...(op.rationale ? { rationale: clean(op.rationale, config.budgets.maxContentChars) } : {}),
      };
      if (!Object.keys(patch).length) {
        out.rejected.push({ ...base, reason: "empty update" });
      } else if (route(clamp01(op.confidence), target.type) === "apply") {
        out.records.push({ v: 1, ts: now, op: "update", id: target.id, patch, src });
        out.applied.push(base);
      } else out.proposals.push(base);
    } else if (op.op === "deprecate") {
      // Removing knowledge is riskier than adding it: a higher bar for doing it unattended.
      if (clamp01(op.confidence) >= Math.max(0.9, config.apply.autoConfidence) && config.apply.autoTypes.includes(target.type)) {
        out.records.push({ v: 1, ts: now, op: "deprecate", id: target.id, reason: String(op.reason ?? ""), src });
        out.applied.push({ ...base, reason: op.reason });
      } else out.proposals.push({ ...base, reason: op.reason });
    }
  }
  return out;
};
