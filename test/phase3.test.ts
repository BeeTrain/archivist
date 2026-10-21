import { describe, expect, it } from "vitest";
import { segmentsFromTranscript } from "../src/adapters/claude/cli/transcript.js";
import { parseCuratorReply } from "../src/analyzer/parse.js";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { computeSignals } from "../src/analyzer/signals.js";
import { PATHS, type Llm } from "../src/core/io.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { gcCandidates, lint, recallText, statsText } from "../src/core/maintenance.js";
import { BASELINE, compareText, loadMetrics, summarize, toMetrics } from "../src/core/metrics.js";
import { renderAll, skillPath } from "../src/core/render.js";
import { listProposals } from "../src/core/review.js";
import { commandsUsed, loadUsage, recordUse, type UsageMap } from "../src/core/usage.js";
import { validateOps } from "../src/core/validate.js";
import { config, entry, memoryIo, segment } from "./helpers.js";

const ts = "2026-10-21T10:00:00.000Z";
const add = (e: ReturnType<typeof entry>) => ({ v: 1 as const, ts, op: "add" as const, entry: e });

describe("transcript → segments", () => {
  const line = (o: object) => JSON.stringify(o);
  const transcript = [
    line({ type: "user", timestamp: "2026-10-01T10:00:00Z", message: { content: "fix the export" } }),
    line({ type: "assistant", timestamp: "2026-10-01T10:00:05Z", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/proj/src/a.ts" } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 } } }),
    line({ type: "assistant", timestamp: "2026-10-01T10:00:06Z", message: { id: "m1", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 } } }),
    line({ type: "user", timestamp: "2026-10-01T10:00:09Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "Exit code 1\nmissing script" }] } }),
    "not json at all",
    line({ type: "attachment", attachment: { type: "date" } }),
    line({ type: "user", isMeta: true, message: { content: "meta" } }),
    line({ type: "user", timestamp: "2026-10-01T10:01:00Z", message: { content: "<command-name>/clear</command-name>" } }),
    line({ type: "user", timestamp: "2026-10-01T11:00:00Z", message: { content: "next task" } }),
    line({ type: "assistant", timestamp: "2026-10-01T11:00:30Z", message: { id: "m2", content: [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/proj/src/b.ts" } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ].join("\n");

  it("cuts one segment per prompt, counts usage once per message, marks failed tools", () => {
    const segs = segmentsFromTranscript(transcript, "/proj", "sess");
    expect(segs.map((s) => s.prompts[0])).toEqual(["fix the export", "next task"]);
    expect(segs[0]!.tools).toEqual([
      { tool: "Read", ok: true, target: "src/a.ts" },
      { tool: "Bash", ok: false, target: "npm test", error: "Exit code 1 missing script" },
    ]);
    expect(segs[0]!.turns[0]).toMatchObject({ durationMs: 60_000, usage: { input: 10, output: 5, cacheRead: 1000 } });
    expect(computeSignals(segs[1]!).edits).toEqual(["src/b.ts"]);
  });
});

describe("metrics", () => {
  it("compares medians of real tasks against the baseline", () => {
    const m = (toolCalls: number, reads: number) =>
      toMetrics({ turns: 1, durationMs: 1000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls, edits: [], readsBeforeFirstEdit: reads, repeatedReads: [], failedCommands: [], corrections: [], rulesLoaded: [] }, ts, "live");
    const before = summarize([m(20, 10), m(30, 12), m(0, 0)]);
    expect(before).toMatchObject({ tasks: 2, medians: { toolCalls: 25, readsBeforeFirstEdit: 11 } });
    const text = compareText({ createdAt: ts, before: ts, sessions: 1, summary: before }, summarize([m(10, 4)]));
    expect(text).toContain("| tool calls | 25 | 10 | −60% |");
    expect(text).toContain("Fewer than 5 tasks");
  });
});

describe("usage and self-correction", () => {
  const cmd = entry({ id: "cmd-a", type: "command", title: "Unit tests", content: "Run `pnpm vitest run <path>` for one module" });

  it("counts a recorded command as used when the task ran it", () => {
    expect(commandsUsed([cmd], [{ tool: "Bash", ok: true, target: "cd app && pnpm vitest run src/x" }])).toEqual(["cmd-a"]);
    expect(commandsUsed([cmd], [{ tool: "Bash", ok: true, target: "pnpm lint" }])).toEqual([]);
  });

  it("flags an entry judged wrong more often than helpful", () => {
    const u: UsageMap = {};
    const known = new Set(["cmd-a"]);
    expect(recordUse(u, { seen: [], used: [], feedback: [{ id: "cmd-a", verdict: "harmful" }], known, ts })).toEqual([]);
    expect(recordUse(u, { seen: [], used: [], feedback: [{ id: "cmd-a", verdict: "harmful" }, { id: "nope", verdict: "harmful" }], known, ts })).toEqual(["cmd-a"]);
    expect(parseCuratorReply('{"ops":[],"feedback":[{"id":"cmd-a","verdict":"harmful"},{"id":"x","verdict":"meh"}]}')?.feedback).toEqual([{ id: "cmd-a", verdict: "harmful" }]);
  });

  it("measures every task, updates counters from feedback, and proposes retiring a misleading entry once", async () => {
    const io = memoryIo({ "package.json": "{}" });
    await appendLedger(io, [add({ ...cmd, evidence: [{ file: "package.json" }] })]);
    const llm: Llm = {
      async reflect() {
        return { ok: true, text: "ENTRIES: WRONG cmd-a", usage: {} };
      },
      async complete() {
        return { ok: true, text: '{"summary":"","ops":[],"feedback":[{"id":"cmd-a","verdict":"harmful"}]}', usage: {} };
      },
    };
    const task = segment([
      { tool: "Bash", target: "pnpm vitest run src/x", ok: false, error: "no vitest" },
      { tool: "Edit", target: "src/x.ts", ok: true },
    ]);
    for (let i = 0; i < 3; i++) await analyzeSegment({ io, llm, config: config(), segment: task, messages: [{ role: "user", text: "fix" }], now: new Date(ts) });
    await analyzeSegment({ io, llm, config: config(), segment: segment([{ tool: "Read", target: "a", ok: true }]), now: new Date(ts) });
    expect((await loadMetrics(io)).length).toBe(4);
    expect((await loadUsage(io))["cmd-a"]).toMatchObject({ harmful: 3, helpful: 0 });
    const deprecations = (await listProposals(io)).filter((p) => p.op.op === "deprecate");
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0]!.reason).toBe("judged wrong in 2 tasks, helpful in 0");
  });
});

describe("procedures", () => {
  const op = { op: "add" as const, type: "procedure" as const, title: "Release a version", content: "1. npm run check\n2. npm version minor\n3. git push --tags", rationale: "cutting a release", confidence: 0.9 };

  it("waits for a repeat, then goes to review, and renders as a skill once applied", async () => {
    const io = memoryIo();
    const first = await validateOps({ ops: [op], entries: new Map(), io, config: config({ autoTypes: ["command", "gotcha", "decision", "procedure"] }), docs: [], now: ts });
    expect(first.rejected[0]?.reason).toBe("procedure seen once: waiting for a repeat");
    expect(first.firstSightings).toHaveLength(1);
    const second = await validateOps({ ops: [op], entries: new Map(), io, config: config({ autoTypes: ["command", "gotcha", "decision", "procedure"] }), docs: [], now: ts, procedureCandidates: first.firstSightings });
    expect(second.proposals[0]).toMatchObject({ type: "procedure", reason: "seen in an earlier task too" });

    const proc = entry({ id: "proc-1", type: "procedure", title: "Release a version", content: op.content, rationale: "cutting a release" });
    await appendLedger(io, [add(proc)]);
    await renderAll(io, (await loadState(io)).entries, config());
    expect(skillPath(proc)).toBe(".claude/skills/archivist-release-a-version/SKILL.md");
    expect(io.files.get(skillPath(proc))).toMatch(/^---\nname: archivist-release-a-version\ndescription: "Release a version\. Use when cutting a release"\n---/);
    expect(io.files.get(PATHS.coreRule)).not.toContain("npm version minor");

    await appendLedger(io, [{ v: 1, ts, op: "deprecate", id: "proc-1", reason: "x" }]);
    expect((await renderAll(io, (await loadState(io)).entries, config())).removed).toEqual([skillPath(proc)]);
  });
});

describe("maintenance", () => {
  const a = entry({ id: "cmd-a", type: "command", title: "Tests", content: "Run `pnpm test` for the unit tests", evidence: [{ file: "package.json" }] });
  const b = entry({ id: "cmd-b", type: "command", title: "Tests", content: "Run `npm test` instead", evidence: [{ file: "package.json" }] });
  const d = entry({ id: "dec-a", type: "decision", title: "Stream CSV", content: "Stream exports", adr: 1 });
  const gone = entry({ id: "gk-g", type: "gotcha", title: "Legacy", content: "Avoid legacy.ts", evidence: [{ file: "legacy.ts" }] });

  it("recalls by words, lints contradictions, stale and reasonless decisions, and finds quiet entries", async () => {
    const io = memoryIo({ "package.json": "{}" });
    await appendLedger(io, [a, b, d, gone].map(add));
    const { entries } = await loadState(io);
    expect(recallText(entries, "unit tests pnpm")).toMatch(/^- `cmd-a` \[command\] Tests: Run `pnpm test`/);
    expect(recallText(entries, "kubernetes")).toBe('Nothing recorded about "kubernetes".');
    const texts = (await lint(io, entries, config())).map((f) => f.text);
    expect(texts).toContain('`cmd-a` and `cmd-b` are both "Tests" with different commands: which one is right?');
    expect(texts).toContain("`gk-g` is stale: every file it cites is gone");
    expect(texts).toContain("`dec-a` is a decision without a reason");
    expect((await gcCandidates(io, entries, 10, new Date("2026-10-30T00:00:00Z"))).map((e) => e.id)).toEqual(["cmd-a", "cmd-b", "gk-g"]);
  });

  it("states the numbers against the baseline", async () => {
    const io = memoryIo();
    io.files.set(BASELINE, JSON.stringify({ createdAt: ts, before: ts, sessions: 2, summary: { tasks: 6, medians: { tokens: 1000, toolCalls: 20, readsBeforeFirstEdit: 8, repeatedReads: 1, failedCommands: 2, durationMs: 60000 } } }));
    expect(await statsText(io, new Map())).toContain("No task measured since Archivist started");
    const task = toMetrics({ turns: 1, durationMs: 30000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 10, edits: ["a"], readsBeforeFirstEdit: 2, repeatedReads: [], failedCommands: [], corrections: [], rulesLoaded: [] }, ts, "live");
    io.files.set(".archivist/.local/metrics.jsonl", JSON.stringify(task) + "\n");
    expect(await statsText(io, new Map())).toContain("| tool calls | 20 | 10 | −50% |");
  });
});
