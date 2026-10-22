import { describe, expect, it } from "vitest";
import { countsText, shouldRecount } from "../src/core/status.js";

describe("status line", () => {
  it("recounts after counts and results, and keeps events on screen", () => {
    // counts: a triage through the CLI may have emptied the queue since they were shown.
    expect(shouldRecount("counts")).toBe(true);
    // result: what the last analysis did, seen; the next turn's end shows the counts again.
    expect(shouldRecount("result")).toBe(true);
    expect(shouldRecount(undefined)).toBe(true);
    // event: analysing, postponed, failed stay until the next analysis replaces them.
    expect(shouldRecount("event")).toBe(false);
  });

  it("shows entries and the queue only when there is something to show", () => {
    expect(countsText(11, 7)).toBe("📚 11 entries · 7 to review");
    expect(countsText(11, 0)).toBe("📚 11 entries");
    expect(countsText(0, 0)).toBeUndefined();
  });
});
