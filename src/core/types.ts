// Agent-agnostic data model. No Node or Claude Code APIs here: everything outside goes through Io / Llm.

export const ENTRY_TYPES = ["command", "gotcha", "decision"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export type EntryStatus = "active" | "deprecated";
export type EntrySource = "analyzer" | "init" | "user";

export interface Evidence {
  /** Project-relative path the fact is backed by. */
  file?: string;
  /** Free-form pointer inside the file: a script name, a symbol, a heading. */
  anchor?: string;
}

/** One atomic fact or rule: what an agent would otherwise have to rediscover. */
export interface Entry {
  id: string;
  type: EntryType;
  title: string;
  /** 1–3 lines, imperative, for the agent. */
  content: string;
  /** Why: required for decisions. */
  rationale?: string;
  scope?: { paths: string[] };
  evidence: Evidence[];
  status: EntryStatus;
  confidence: number;
  source: EntrySource;
  created: string;
  updated: string;
  /** ADR number, for decisions. */
  adr?: number;
  supersedes?: string[];
  deprecatedReason?: string;
  reinforced: number;
}

/** Provenance kept in the committed ledger: the task's segment id only. Session ids stay on the machine. */
export interface RecordSource {
  segment?: string;
}

/** One line of .archivist/ledger.jsonl: the append-only source of truth. */
export type LedgerRecord =
  | { v: 1; ts: string; op: "add"; entry: Entry; src?: RecordSource }
  | { v: 1; ts: string; op: "update"; id: string; patch: EntryPatch; src?: RecordSource }
  | { v: 1; ts: string; op: "deprecate"; id: string; reason: string; src?: RecordSource }
  | { v: 1; ts: string; op: "reinforce"; id: string; src?: RecordSource };

export type EntryPatch = Partial<Pick<Entry, "title" | "content" | "rationale" | "scope" | "evidence" | "confidence">>;

/** What the curator model proposes; validated before it becomes a LedgerRecord. */
export type ProposedOp =
  | {
      op: "add";
      type: EntryType;
      title: string;
      content: string;
      rationale?: string;
      scope?: { paths: string[] };
      evidence?: Evidence[];
      confidence: number;
      supersedes?: string[];
      savings?: Savings;
    }
  | { op: "update"; id: string; title?: string; content?: string; rationale?: string; confidence: number; savings?: Savings }
  | { op: "deprecate"; id: string; reason: string; confidence: number }
  | { op: "reinforce"; id: string; confidence?: number };

export interface Savings {
  toolCalls?: number;
  tokens?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export const addUsage = (a: Usage, b: Partial<Usage>): Usage => ({
  input: a.input + (b.input ?? 0),
  output: a.output + (b.output ?? 0),
  cacheRead: a.cacheRead + (b.cacheRead ?? 0),
  cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
});

/** Cache reads cost ~0.1× of fresh input; this is what daily budgets count. */
export const weightedTokens = (u: Usage): number =>
  u.input + u.output + u.cacheWrite + Math.round(u.cacheRead * 0.1);

/** A tool call seen during the task, without its content. */
export interface ToolEvent {
  tool: string;
  /** File path, command (truncated) or pattern. */
  target?: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  agent?: string;
}

/** What the adapter collects while a task runs. */
export interface Segment {
  id: string;
  session: string;
  startedAt: number;
  prompts: string[];
  answers: string[];
  turns: { turnId: string; durationMs: number; usage: Usage }[];
  tools: ToolEvent[];
  rulesLoaded: { file: string; trigger?: string }[];
}

/** A chat message as the adapter can read it back (Claude Code: $.session.messages()). */
export interface Message {
  role: "user" | "assistant";
  text: string;
  toolUses?: { tool: string; input: Record<string, unknown>; isError?: boolean; text?: string }[];
}
