import { describe, expect, it } from "vitest";
import { panelSnapshot, startPanel } from "../src/cli/panel.js";
import { PATHS } from "../src/core/io.js";
import { appendLedger } from "../src/core/ledger.js";
import { entry, memoryIo } from "./helpers.js";

describe("Archivist panel", () => {
  it("counts active records and reflects external queue changes without writing files", async () => {
    const io = memoryIo();
    const ts = new Date().toISOString();
    await appendLedger(io, [
      { v: 1, ts, op: "add", entry: entry({ id: "a", type: "gotcha", title: "Active", content: "Text" }) },
      { v: 1, ts, op: "add", entry: entry({ id: "b", type: "command", title: "Old", content: "Text", status: "deprecated" }) },
    ]);
    const before = new Map(io.files);
    expect((await panelSnapshot(io)).counts).toEqual({ entries: 1, review: 0 });
    expect(io.files).toEqual(before);
    const file = `${PATHS.proposals}/stable-id.json`;
    io.files.set(file, JSON.stringify({ ts, op: { op: "deprecate", id: "a", reason: "No longer relevant" } }));
    const state = await panelSnapshot(io);
    expect(state.counts).toEqual({ entries: 1, review: 1 });
    expect(state.proposals[0]).toMatchObject({ id: "stable-id", text: "− a: No longer relevant" });
    io.files.delete(file);
    expect((await panelSnapshot(io)).counts.review).toBe(0);
  });

  it("serves live data only through the private read-only loopback routes", async () => {
    const io = memoryIo();
    const { server, url } = await startPanel(io);
    try {
      expect(server.address()).toMatchObject({ address: "127.0.0.1" });
      const page = await fetch(url);
      expect(await page.text()).toContain('lang="ru"');
      expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-");
      expect((await fetch(new URL("/state", url))).status).toBe(404);
      expect((await fetch(url + "state", { method: "POST" })).status).toBe(405);
      expect((await fetch(url + "../ledger.jsonl")).status).toBe(404);
      const first = await fetch(url + "state");
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.json()).toMatchObject({ counts: { entries: 0, review: 0 } });
      io.files.set(`${PATHS.proposals}/new.json`, JSON.stringify({ op: { op: "reinforce", id: "a" } }));
      expect(await (await fetch(url + "state")).json()).toMatchObject({ counts: { entries: 0, review: 1 } });
      io.read = async () => { throw new Error("private failure details"); };
      const failed = await fetch(url + "state");
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("private failure");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
