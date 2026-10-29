import { describe, expect, it } from "vitest";
import { memoryLane } from "../src/core/memory-lane.js";
import type { SyncMode } from "../src/core/memory.js";

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

describe("one memory sync at a time", () => {
  it("folds the syncs asked for while one runs into the strongest of them", async () => {
    const lane = memoryLane();
    const runs: SyncMode[] = [];
    const first = gate();
    void lane.sync("fast", async (mode) => {
      runs.push(mode);
      await first.opened;
    });
    await Promise.resolve();
    const next = lane.sync("start", async (mode) => void runs.push(mode));
    void lane.sync("fast", async (mode) => void runs.push(mode));
    first.open();
    await next;
    expect(runs).toEqual(["fast", "start"]);
  });

  it("makes a sync by hand wait for the running one, and keeps later syncs out until it ends", async () => {
    const lane = memoryLane();
    const events: string[] = [];
    const running = gate();
    void lane.sync("start", async () => {
      events.push("start begins");
      await running.opened;
      events.push("start ends");
    });
    await Promise.resolve();
    const byHand = lane.byHand(async () => {
      events.push("by hand");
      return "synced";
    });
    const later = lane.sync("fast", async () => void events.push("fast"));
    running.open();
    expect(await byHand).toBe("synced");
    await later;
    expect(events).toEqual(["start begins", "start ends", "by hand", "fast"]);
  });

  it("goes on after a sync that failed", async () => {
    const lane = memoryLane();
    await lane
      .sync("fast", async () => {
        throw new Error("down");
      })
      .catch(() => undefined);
    expect(await lane.byHand(async () => "next")).toBe("next");
  });
});
