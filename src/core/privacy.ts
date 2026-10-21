// Keeps secrets out of what the analyzer sends to a model and out of what Archivist writes into the repo.
import { globToRegExp } from "./text.js";

const MASK = "[redacted]";

/** Token shapes common enough to be worth catching. Not exhaustive: a second line of defence, not a scanner. */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
];

/** `password=…`, `API_KEY: "…"`: keep the name, mask the value. */
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`]{6,})\3/gi;

export const redact = (text: string): { text: string; count: number } => {
  let count = 0;
  let out = text.replace(ASSIGNMENT, (_m, name: string, sep: string, q: string, value: string) => {
    // `token: string`, `password=${PASSWORD}`: types and references, not values.
    if (/^(\$\{?|process\.env|string|number|boolean|undefined|null|<)/.test(value)) return `${name}${sep}${q}${value}${q}`;
    count++;
    return `${name}${sep}${q}${MASK}${q}`;
  });
  for (const re of SECRETS) {
    out = out.replace(re, (m) => {
      count++;
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(m) ? `${m.split("://")[0]}://${MASK}@` : MASK;
    });
  }
  return { text: out, count };
};

export const isExcluded = (path: string, globs: string[]): boolean => globs.some((g) => globToRegExp(g).test(path));
