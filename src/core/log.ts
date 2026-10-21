// The mod's diagnostic log. The plugin store is shared by every project on the machine, so each project keeps
// its own log under its own key: `/archivist log` then shows what happened here, not in some other repo.

export const LOG_LINES = 100;

export const logKey = (root: string): string => `archivist:log:${root}`;

/** The log with one line added, the oldest dropped past `max`. */
export const withLine = (lines: readonly string[] | undefined, line: string, at: Date, max = LOG_LINES): string[] =>
  [...(lines ?? []), `${at.toISOString()} ${line}`].slice(-max);
