import { PATHS, type Io } from "./io.js";
import type { EntryType } from "./types.js";

export interface Config {
  enabled: boolean;
  /** Language of recorded entries: "auto" follows the user's prompts; otherwise a name such as "Russian" or "English". */
  language: string;
  analyzer: {
    /** Quiet time after a turn before the task is considered done. */
    idleSeconds: number;
    /** Tasks with fewer tool calls and no edits are skipped (NOOP). */
    minToolCalls: number;
    /** "fork": ask the main model over its own cached transcript; "digest": only the cheap model over a digest. */
    reflect: "fork" | "digest";
    /**
     * Above this many tokens of live context, reflect falls back to the digest: fork re-reads the whole
     * context from cache, and its price grows with the session while the task stays the same size.
     */
    forkMaxContextTokens: number;
    curateModel: string;
    /** Weighted tokens (cache reads count 0.1×) the analyzer may spend per day. */
    maxTokensPerDay: number;
    /** Skip analysis while a rate-limit window is fuller than this. */
    maxRateLimitPercent: number;
  };
  apply: {
    autoConfidence: number;
    autoTypes: EntryType[];
  };
  budgets: {
    /** Lines in the always-loaded .claude/rules/archivist/core.md. */
    coreLines: number;
    /** Lines in each path-scoped rule file, loaded only when the agent touches matching files. */
    pathFileLines: number;
    maxContentChars: number;
  };
  privacy: {
    /** Files that never reach the journal, a model or an entry's evidence. */
    excludePaths: string[];
  };
  report: {
    mode: "quiet" | "rewake";
    toastMs: number;
  };
  review: {
    /** A technical fact proposed again in a later task, while the first proposal still waits, is applied: two sightings. */
    promoteOnRepeat: boolean;
    /** Unreviewed proposals are dropped after this many days or analysed tasks, whichever comes first. */
    expireDays: number;
    expireTasks: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  language: "auto",
  analyzer: {
    idleSeconds: 90,
    minToolCalls: 5,
    reflect: "fork",
    forkMaxContextTokens: 300_000,
    curateModel: "haiku",
    maxTokensPerDay: 3_000_000,
    maxRateLimitPercent: 90,
  },
  apply: { autoConfidence: 0.8, autoTypes: ["command", "gotcha", "decision"] },
  budgets: { coreLines: 60, pathFileLines: 40, maxContentChars: 400 },
  privacy: { excludePaths: [".env*", "**/.env*", "**/secrets/**", "**/*.pem", "**/*.key", "**/id_rsa*"] },
  report: { mode: "quiet", toastMs: 15_000 },
  review: { promoteOnRepeat: true, expireDays: 14, expireTasks: 20 },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

const merge = <T extends object>(base: T, over: DeepPartial<T> | undefined): T => {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" ? merge(b as object, v as object) : v;
  }
  return out as T;
};

export const loadConfig = async (io: Io): Promise<Config> => {
  const raw = await io.read(PATHS.config);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return merge(DEFAULT_CONFIG, JSON.parse(raw) as DeepPartial<Config>);
  } catch {
    return DEFAULT_CONFIG;
  }
};
