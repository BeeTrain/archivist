import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { clockText, holdOf } from "../src/core/hold.js";

const analyzer = DEFAULT_CONFIG.analyzer;
const now = new Date("2026-10-23T12:00:00.000Z");
const reset = "2026-10-25T08:00:00.000Z";
const at = (iso: string) => clockText(new Date(iso));

describe("analysis hold", () => {
  it("lets the analysis run below the limits", () => {
    expect(holdOf(0, [], analyzer, now)).toBeUndefined();
    expect(holdOf(1000, [{ kind: "seven_day", percentUsed: 89.9, resetsAt: reset }], analyzer, now)).toBeUndefined();
  });

  it("says when a full window resets and how to run on credits", () => {
    const hold = holdOf(0, [{ kind: "seven_day", percentUsed: 100, resetsAt: reset }], analyzer, now);
    // The log keeps the old wording: health counts postponed analyses by it.
    expect(hold?.reason).toBe("seven_day rate limit at 100%");
    expect(hold?.status).toBe(`📚 analysis waits till ${at(reset)} (seven_day limit at 100%) · analyzer.useCredits runs it on credits`);
  });

  it("waits for the latest reset when several windows are full", () => {
    const soon = "2026-10-23T15:00:00.000Z";
    const hold = holdOf(0, [{ kind: "five_hour", percentUsed: 95, resetsAt: soon }, { kind: "seven_day", percentUsed: 100, resetsAt: reset }], analyzer, now);
    expect(hold?.status).toContain(`till ${at(reset)} (five_hour limit at 95%, seven_day limit at 100%)`);
  });

  it("leaves the time out when a window does not say when it resets", () => {
    const hold = holdOf(0, [{ kind: "seven_day", percentUsed: 100 }], analyzer, now);
    expect(hold?.status).toBe("📚 analysis waits (seven_day limit at 100%) · analyzer.useCredits runs it on credits");
  });

  it("runs past the subscription windows on credits, but never past a spend limit", () => {
    const credits = { ...analyzer, useCredits: true };
    expect(holdOf(0, [{ kind: "five_hour", percentUsed: 100, resetsAt: reset }, { kind: "seven_day", percentUsed: 100, resetsAt: reset }], credits, now)).toBeUndefined();
    const hold = holdOf(0, [{ kind: "seven_day", percentUsed: 100 }, { kind: "spend_limit", percentUsed: 104, resetsAt: reset }], credits, now);
    expect(hold?.reason).toBe("spend_limit rate limit at 104%");
    // Credits do not lift a spend limit: no hint to turn them on.
    expect(hold?.status).toBe(`📚 analysis waits till ${at(reset)} (spend_limit limit at 104%)`);
  });

  it("holds a spent daily budget until the next UTC day, whatever the windows say", () => {
    const hold = holdOf(3_000_000, [], { ...analyzer, useCredits: true }, now);
    expect(hold?.reason).toBe("daily budget used (3000000/3000000)");
    expect(hold?.status).toBe(`📚 analysis waits till ${at("2026-10-24T00:00:00.000Z")} (daily budget used) · raise analyzer.maxTokensPerDay`);
  });

  it("writes local time the way the status line has room for", () => {
    expect(clockText(new Date(2026, 9, 25, 11, 0))).toBe("Oct 25 11:00");
    expect(clockText(new Date(2026, 0, 3, 7, 5))).toBe("Jan 3 07:05");
  });
});
