import { describe, expect, it } from "vitest";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { PATHS, type Llm } from "../src/core/io.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { healthText } from "../src/core/maintenance.js";
import { ANALYSES, BASELINE, METRICS, loadAnalyses } from "../src/core/metrics.js";
import { USAGE } from "../src/core/usage.js";
import { config, entry, memoryIo, segment } from "./helpers.js";

const now = new Date("2026-10-22T12:00:00.000Z");
const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const add = (e: ReturnType<typeof entry>) => ({ v: 1 as const, ts: e.created, op: "add" as const, entry: e });

describe("health", () => {
  it("says there is nothing to do when the project is fine", async () => {
    const io = memoryIo({ "package.json": "{}" });
    await appendLedger(io, [add(entry({ id: "cmd-a", type: "command", title: "Tests", content: "`npm test`", evidence: [{ file: "package.json" }], created: day(30) }))]);
    io.files.set(USAGE, JSON.stringify({ "cmd-a": { seen: 0, used: 3, helpful: 1, harmful: 0 } }));
    io.files.set(BASELINE, JSON.stringify({ createdAt: day(30), before: day(30), sessions: 1, summary: { tasks: 5, medians: {} } }));
    io.files.set(METRICS, jsonl([1, 2, 3].map((d) => ({ ts: day(d), source: "live", toolCalls: 8 }))));
    io.files.set(ANALYSES, jsonl([{ ts: day(1), outcome: "done", applied: 1, proposals: 0, dropped: 1, tokens: 9000 }, { ts: day(2), outcome: "skipped", applied: 0, proposals: 0, dropped: 0, tokens: 0 }]));
    const text = await healthText(io, (await loadState(io)).entries, config(), now, { log: [], spentToday: 4000 });
    expect(text).toContain("- 3 tasks seen; 2 analysed: 1 fully, 1 skipped as trivial");
    expect(text).toContain("- recorded 1 entries, proposed 0; analysis cost 9k weighted tokens (today 4k of 3000k)");
    expect(text).toContain("- 1 of 1 met in a task");
    expect(text).toContain("- Nothing: Archivist is doing fine here.");
  });

  it("names each problem and what to do about it", async () => {
    const io = memoryIo({ "package.json": "{}" });
    const old = (id: string, title: string, evidence = "package.json") =>
      entry({ id, type: "gotcha", title, content: `${title}: a distinct fact number ${id}`, evidence: [{ file: evidence }], created: day(20) });
    await appendLedger(io, [old("gk-1", "Alpha"), old("gk-2", "Beta"), old("gk-3", "Gamma"), old("gk-4", "Gone", "src/removed.ts")].map(add));
    io.files.set(`${PATHS.proposals}/p-0.json`, JSON.stringify({ ts: day(1), op: { op: "add", type: "decision", title: "Stream CSV", content: "Stream exports", rationale: "1 GB", confidence: 0.7 } }));
    io.files.set(METRICS, jsonl(Array.from({ length: 6 }, (_, i) => ({ ts: day(i + 1), source: "live", toolCalls: 9 }))));
    io.files.set(ANALYSES, jsonl(Array.from({ length: 6 }, (_, i) => ({ ts: day(i + 1), outcome: "done", applied: 0, proposals: 0, dropped: 2, tokens: 5000, ...(i === 0 ? { error: "curate: api-error" } : {}) }))));
    const log = [`${day(1)} seg x: failed: boom`, `${day(2)} seg y: postponed: five_hour rate limit at 95%`, `${day(9)} seg z: failed: too old to count`];
    const text = await healthText(io, (await loadState(io)).entries, config(), now, { log });
    expect(text).toContain("- review queue: 1 (1 decisions or removals wait for you)");
    expect(text).toContain("- problems: 1 analyses with model errors, 1 failed, 1 postponed");
    expect(text).toContain("- never met, older than a week: `gk-1` Alpha; `gk-2` Beta; `gk-3` Gamma");
    expect(text).toContain("- `gk-4` is stale: every file it cites is gone");
    const todo = text.split("## What to do\n")[1]!;
    expect(todo).toContain("/archivist:triage: 1 proposals, 1 of them need your yes or no");
    expect(todo).toContain("/archivist log: some analyses failed");
    expect(todo).toContain("1 stale entries");
    expect(todo).toContain("3 entries never met in a week");
    expect(todo).toContain("nothing recorded in a week of tasks");
    expect(todo).toContain("no baseline yet");
  });
});

describe("analysis journal", () => {
  it("records trivial and full analyses with their outcome and cost", async () => {
    const io = memoryIo();
    const llm: Llm = {
      async complete() {
        return { ok: true, text: '{"summary":"","ops":[{"op":"add","type":"gotcha","title":"Flaky login test","content":"Retry the login e2e test once before failing","confidence":0.9}]}', usage: { input: 2000, output: 300 } };
      },
    };
    await analyzeSegment({ io, llm, config: config(), segment: segment([{ tool: "Read", target: "a", ok: true }]), now });
    await analyzeSegment({ io, llm, config: config(), segment: { ...segment([{ tool: "Edit", target: "src/a.ts", ok: true }]), id: "seg2" }, now });
    expect(await loadAnalyses(io)).toEqual([
      { ts: now.toISOString(), segment: "seg1", outcome: "skipped", applied: 0, proposals: 0, dropped: 0, tokens: 0 },
      { ts: now.toISOString(), segment: "seg2", outcome: "done", applied: 1, proposals: 0, dropped: 0, tokens: 2300 },
    ]);
  });
});
