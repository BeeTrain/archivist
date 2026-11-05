import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIo } from "../src/cli/node-io.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { listProposals } from "../src/core/review.js";
import { Collector } from "../src/adapters/opencode/queue.js";
import { uiSnapshot, uiReport, settleProposal } from "../src/adapters/opencode/snapshot.js";
import { analysisLabel, entryCount, pillLabel, pillTone } from "../src/adapters/opencode/ui-state.js";
import type { UiSnapshot } from "../src/adapters/opencode/rpc.js";
import { entry, memoryIo } from "./helpers.js";

const fixture = (): UiSnapshot => ({
  project: "project", enabled: true, analysisEnabled: true, counts: { entries: 42, review: 3 }, entries: [], matching: 0, proposals: [],
  analysis: { state: "idle", message: "Ожидание задачи", due: null }, result: null, lastReport: null,
});
const op = { op: "add", type: "gotcha", title: "Migration requires explicit transaction", content: "Run schema changes inside an explicit transaction to prevent partially applied migration batches.", evidence: [{ file: "src/db.ts" }], confidence: 1 };
const seedProposal = async (io: ReturnType<typeof memoryIo>) => {
  await io.write("src/db.ts", "exists");
  await io.write(".archivist/.local/proposals/test-1.json", JSON.stringify({ ts: "2026-11-05T16:00:00Z", op, reason: "Review required" }));
};

describe("OpenCode GUI data", () => {
  it("uses current ledger counts, searches the whole base and keeps task contents out of snapshots", async () => {
    const io = memoryIo();
    for (const item of [entry({ id: "a", type: "command", title: "Test", content: "npm test" }), entry({ id: "b", type: "gotcha", title: "Transactions", content: "Use transactions" })])
      await appendLedger(io, [{ v: 1, ts: item.created, op: "add", entry: item }]);
    const value = await uiSnapshot(io, "private-session", "transactions");
    expect(value.counts.entries).toBe(2);
    expect(value.entries.map((entry) => entry.id)).toEqual(["b"]);
    expect(JSON.stringify(value)).not.toContain("private-session");
    const item = entry({ id: "c", type: "command", title: "Build", content: "npm run build" });
    await appendLedger(io, [{ v: 1, ts: item.created, op: "add", entry: item }]);
    expect((await uiSnapshot(io, "private-session")).counts.entries).toBe(3);
  });

  it("rejects stale review actions and only applies the version shown to the user", async () => {
    const io = memoryIo();
    await seedProposal(io);
    const proposal = (await uiSnapshot(io, "session")).proposals[0]!;
    await expect(settleProposal(io, { id: proposal.id, fingerprint: "0".repeat(64), action: "apply" })).rejects.toThrow("изменилось");
    expect((await loadState(io)).entries.size).toBe(0);
    expect(await listProposals(io)).toHaveLength(1);
    await settleProposal(io, { id: proposal.id, fingerprint: proposal.fingerprint, action: "apply" });
    expect((await loadState(io)).entries.size).toBe(1);
    expect(await listProposals(io)).toHaveLength(0);
    await expect(settleProposal(io, { id: proposal.id, fingerprint: proposal.fingerprint, action: "apply" })).rejects.toThrow("разобрано");
  });

  it("marks decisions for the user and skips a proposal without adding knowledge", async () => {
    const io = memoryIo();
    await seedProposal(io);
    await io.write(".archivist/.local/proposals/test-2.json", JSON.stringify({ op: { ...op, type: "decision", rationale: "An agreed choice" } }));
    const proposals = (await uiSnapshot(io, "session")).proposals;
    expect(proposals[0]?.human).toBe(false);
    expect(proposals[0]?.kind).toBe("Ловушка");
    expect(proposals[0]?.title).toBe(op.title);
    expect(proposals[0]?.content).toBe(op.content);
    expect(proposals[1]?.human).toBe(true);
    await settleProposal(io, { ...proposals[0]!, action: "skip" });
    expect((await loadState(io)).entries.size).toBe(0);
    expect(await listProposals(io)).toHaveLength(1);
  });

  it("keeps the last report after the next prompt but clears the completed result from the status", async () => {
    const root = await mkdtemp(join(tmpdir(), "archivist-opencode-ui-"));
    const io = nodeIo(root, "opencode");
    const collector = new Collector(io, () => ({ complete: async () => ({ ok: true, text: JSON.stringify({ summary: "Validated migration lesson", ops: [op], feedback: [] }), usage: { input: 100, output: 50 } }) }));
    try {
      await io.write(".archivist/config.json", JSON.stringify({ ...DEFAULT_CONFIG, analyzer: { ...DEFAULT_CONFIG.analyzer, minToolCalls: 0, idleSeconds: 1 } }));
      await io.write("src/db.ts", "exists");
      await collector.prompt("session", "prompt1", "Fix the migration", 1000);
      await collector.model("session", { providerID: "test", id: "model" });
      await collector.idle("session", undefined, 2000);
      await collector.process("session", 3000);
      const done = await uiSnapshot(io, "session");
      expect(done.result?.proposed).toBe(1);
      expect(done.counts.review).toBe(1);
      expect((await uiReport(io, "session")).text).toContain("Validated migration lesson");
      await collector.prompt("session", "prompt2", "Continue the work", 4000);
      const next = await uiSnapshot(io, "session");
      expect(next.result).toBeNull();
      expect(next.lastReport?.id).toBe(done.result?.id);
      expect(analysisLabel(next)).toBe("Сбор контекста");
      expect((await uiReport(io, "session")).text).toContain("Validated migration lesson");
    } finally { collector.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("shows live status text, disabled analysis and correct Russian counts", () => {
    const value = fixture();
    expect(pillLabel(value)).toContain("42 записи · 3 на ревью");
    expect(pillTone(value)).toBe("warning");
    value.analysis.state = "analysing";
    expect(analysisLabel(value)).toBe("Анализируется…");
    value.analysis.state = "failed";
    expect(pillTone(value)).toBe("danger");
    value.analysisEnabled = false;
    expect(analysisLabel(value)).toBe("Анализ выключен");
    value.enabled = false;
    expect(analysisLabel(value)).toBe("Архивист выключен");
    expect([1, 2, 5, 11, 21].map(entryCount)).toEqual(["1 запись", "2 записи", "5 записей", "11 записей", "21 запись"]);
  });
});
