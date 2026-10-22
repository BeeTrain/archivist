// The status line by the prompt box: what it says, and when it is worked out again.

/**
 * counts: entries and the review queue, recounted whenever there is a chance; anything else (a triage through the
 * CLI, an edit) may have changed them. result: what the last analysis did, kept until the next turn ends.
 * event: analysing, postponed, failed, kept until the next analysis says otherwise, so a problem stays visible.
 */
export type StatusKind = "counts" | "result" | "event";

/** At a turn's end or when an app attaches: recount, unless an event has to stay on screen. */
export const shouldRecount = (kind: StatusKind | undefined): boolean => kind !== "event";

export const countsText = (entries: number, queued: number): string | undefined =>
  entries || queued ? `📚 ${entries} entries${queued ? ` · ${queued} to review` : ""}` : undefined;
