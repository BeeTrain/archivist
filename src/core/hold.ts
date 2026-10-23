// Whether an analysis waits: the daily budget and the account's rate-limit windows.

import type { Config } from "./config.js";

/** One rate-limit window as the session reports it. */
export interface RateLimit {
  kind: string;
  percentUsed: number;
  /** ISO 8601. */
  resetsAt?: string;
}

export interface Hold {
  /** For the log: what holds the analysis back. */
  reason: string;
  /** For the status line: the reason, when it lifts, and how to go ahead anyway. */
  status: string;
}

/** The subscription's windows: usage credits pay past them. A gateway's spend limit is a hard stop. */
const CREDIT_WINDOWS = new Set(["five_hour", "seven_day"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number): string => String(n).padStart(2, "0");

/** Local time, the way the status line has room for it: "Oct 25 11:00". */
export const clockText = (d: Date): string => `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const statusText = (until: Date | undefined, why: string, hint: string | undefined): string =>
  `📚 analysis waits${until ? ` till ${clockText(until)}` : ""} (${why})${hint ? ` · ${hint}` : ""}`;

/**
 * Why the analysis has to wait, or undefined when it may run. `spent` counts against the day in UTC, as the mod keys
 * it; the windows come from the last API response.
 */
export const holdOf = (spent: number, limits: RateLimit[], analyzer: Config["analyzer"], now: Date): Hold | undefined => {
  if (spent >= analyzer.maxTokensPerDay) {
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return {
      reason: `daily budget used (${spent}/${analyzer.maxTokensPerDay})`,
      status: statusText(midnight, "daily budget used", "raise analyzer.maxTokensPerDay"),
    };
  }
  const full = limits
    .filter((l) => l.percentUsed >= analyzer.maxRateLimitPercent)
    .filter((l) => !(analyzer.useCredits && CREDIT_WINDOWS.has(l.kind)));
  if (!full.length) return undefined;
  // It runs again only once every full window has reset: the latest reset is when.
  const resets = full.map((l) => (l.resetsAt ? Date.parse(l.resetsAt) : NaN));
  const until = resets.some(Number.isNaN) ? undefined : new Date(Math.max(...resets));
  const why = full.map((l) => `${l.kind} limit at ${l.percentUsed}%`).join(", ");
  const onCredits = full.every((l) => CREDIT_WINDOWS.has(l.kind));
  return {
    reason: full.map((l) => `${l.kind} rate limit at ${l.percentUsed}%`).join(", "),
    status: statusText(until, why, onCredits ? "analyzer.useCredits runs it on credits" : undefined),
  };
};
