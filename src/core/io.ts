// The only way the core touches the outside world. The Claude Code mod implements it on `$.fs`,
// the CLI on `node:fs`, tests in memory.

export interface Io {
  /** Absolute project root; every path below is relative to it. */
  root: string;
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  remove?(path: string): Promise<void>;
  /** Removes a directory only if it is empty; a no-op otherwise, so nothing someone else put there goes. */
  removeEmptyDir?(path: string): Promise<void>;
}

/** The model calls the analyzer needs. */
export interface Llm {
  /** Ask about the task with the full session context (Claude Code: $.model.fork). Undefined if unavailable. */
  reflect?(prompt: string): Promise<LlmReply>;
  /** A cheap context-free completion (Claude Code: $.model.complete on haiku). */
  complete(req: { system: string; prompt: string; maxTokens: number }): Promise<LlmReply>;
}

export type LlmReply =
  | { ok: true; text: string; usage: Partial<import("./types.js").Usage> }
  | { ok: false; reason: string; usage?: Partial<import("./types.js").Usage> };

export const PATHS = {
  dir: ".archivist",
  config: ".archivist/config.json",
  ledger: ".archivist/ledger.jsonl",
  index: ".archivist/INDEX.md",
  decisions: ".archivist/decisions",
  // Reports quote the user's prompts and session ids; proposals are one person's queue: both stay local.
  reports: ".archivist/.local/reports",
  proposals: ".archivist/.local/proposals",
  gitignore: ".archivist/.gitignore",
  rulesDir: ".claude/rules/archivist",
  skillsDir: ".claude/skills",
  coreRule: ".claude/rules/archivist/core.md",
} as const;

export const joinPath = (...parts: string[]): string =>
  parts
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");

/** Makes an absolute path project-relative when it is under the root. */
export const relPath = (root: string, path: string): string => {
  const r = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(r) ? path.slice(r.length) : path;
};
