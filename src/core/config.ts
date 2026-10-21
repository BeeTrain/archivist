import { PATHS, type Io } from "./io.js";
import type { EntryType } from "./types.js";

export interface Config {
  enabled: boolean;
  analyzer: {
    /** Quiet time after a turn before the task is considered done. */
    idleSeconds: number;
    /** Tasks with fewer tool calls and no edits are skipped (NOOP). */
    minToolCalls: number;
    /** "fork": ask the main model over its own cached transcript; "digest": only the cheap model over a digest. */
    reflect: "fork" | "digest";
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
    maxContentChars: number;
  };
  report: {
    mode: "quiet" | "rewake";
    toastMs: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  analyzer: {
    idleSeconds: 90,
    minToolCalls: 5,
    reflect: "fork",
    curateModel: "haiku",
    maxTokensPerDay: 3_000_000,
    maxRateLimitPercent: 90,
  },
  apply: { autoConfidence: 0.8, autoTypes: ["command", "gotcha", "decision"] },
  budgets: { coreLines: 60, maxContentChars: 400 },
  report: { mode: "quiet", toastMs: 15_000 },
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
