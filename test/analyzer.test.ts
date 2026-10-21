import { describe, expect, it } from "vitest";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { extractJson, parseCuratorReply } from "../src/analyzer/parse.js";
import { statusLine } from "../src/analyzer/report.js";
import { computeSignals, isTrivial } from "../src/analyzer/signals.js";
import { sliceTask } from "../src/analyzer/digest.js";
import { CURATE_SYSTEM, reflectPrompt } from "../src/analyzer/prompts.js";
import { PATHS, type Llm } from "../src/core/io.js";
import { loadState } from "../src/core/ledger.js";
import { scanCommands, scriptCommand } from "../src/cli/scan.js";
import { config, memoryIo, segment } from "./helpers.js";

const busyTask = segment([
  { tool: "Grep", target: "export", ok: true },
  { tool: "Read", target: "src/export.ts", ok: true },
  { tool: "Read", target: "src/export.ts", ok: true },
  { tool: "Bash", target: "npm test", ok: false, error: "Exit code 1 missing script" },
  { tool: "Bash", target: "npm run test:unit", ok: true },
  { tool: "Edit", target: "src/export.ts", ok: true },
]);

describe("signals", () => {
  it("measures exploration, re-reads and recovered commands", () => {
    const s = computeSignals(busyTask);
    expect(s).toMatchObject({ readsBeforeFirstEdit: 3, edits: ["src/export.ts"], repeatedReads: [{ file: "src/export.ts", times: 2 }] });
    expect(s.recoveredCommands).toEqual([{ failed: "npm test", succeeded: "npm run test:unit" }]);
    expect(isTrivial(s, config())).toBe(false);
    expect(isTrivial(computeSignals(segment([{ tool: "Read", target: "a", ok: true }])), config())).toBe(true);
  });

  it("counts looking around through the shell as exploration", () => {
    const s = computeSignals(
      segment([
        { tool: "Bash", target: "cat package.json", ok: true },
        { tool: "Bash", target: "cd src && grep -rn export .", ok: true },
        { tool: "Bash", target: "sed -n 1,40p src/a.ts", ok: true },
        { tool: "Bash", target: "npm test", ok: true },
        { tool: "Write", target: "README.md", ok: true },
        { tool: "Bash", target: "cat README.md", ok: true },
      ]),
    );
    expect(s.readsBeforeFirstEdit).toBe(3);
  });
});

describe("prompts", () => {
  it("scopes the reflection to the task and keeps entries atomic", () => {
    expect(reflectPrompt("напиши README")).toContain("Look ONLY at the most recent task: the messages from the user's request «напиши README»");
    expect(CURATE_SYSTEM).toContain("it must not repeat the title");
    expect(CURATE_SYSTEM).toContain("Never record one-off operations");
  });
});

describe("parse", () => {
  it("finds JSON in fences or prose, and gives up on garbage", () => {
    expect(extractJson('Here:\n```json\n{"ops":[]}\n```')).toEqual({ ops: [] });
    expect(extractJson('ok {"a":"}{","b":{"c":1}} trailing')).toEqual({ a: "}{", b: { c: 1 } });
    expect(parseCuratorReply("no json here")).toBeUndefined();
    expect(parseCuratorReply('{"summary":"s","ops":[{"op":"reinforce","id":"x"},{"nope":1}]}')?.ops).toHaveLength(1);
  });

  it("finds the task's start in the session messages", () => {
    const msgs = [
      { role: "user" as const, text: "old task" },
      { role: "assistant" as const, text: "ok" },
      { role: "user" as const, text: "fix the export please" },
      { role: "assistant" as const, text: "done" },
    ];
    expect(sliceTask(msgs, "fix the export")).toHaveLength(2);
  });
});

const fakeLlm = (curated: string, reflect?: string): Llm & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    ...(reflect !== undefined
      ? {
          async reflect(prompt: string) {
            calls.push(`reflect:${prompt.slice(0, 20)}`);
            return reflect ? { ok: true as const, text: reflect, usage: { cacheRead: 200_000, output: 150 } } : { ok: false as const, reason: "nothing-to-fork" };
          },
        }
      : {}),
    async complete({ prompt }) {
      calls.push(`complete:${prompt.includes("NOTES FROM THE AGENT") ? "reflection" : "digest"}`);
      return { ok: true, text: curated, usage: { input: 3000, output: 300 } };
    },
  };
};

const curated = JSON.stringify({
  summary: "the unit tests run with test:unit",
  ops: [
    { op: "add", type: "command", title: "Unit tests", content: "Run `npm run test:unit`; `npm test` does not exist", evidence: [{ file: "package.json", anchor: "scripts.test:unit" }], confidence: 0.95, savings: { toolCalls: 2, tokens: 8000 } },
    { op: "add", type: "decision", title: "Stream the CSV export", content: "Export CSV as a stream", rationale: "exports exceed 1 GB", evidence: [{ file: "src/export.ts" }], confidence: 0.9 },
    { op: "add", type: "gotcha", title: "Unsure", content: "Maybe something about caching", confidence: 0.5 },
  ],
});

describe("analyzeSegment", () => {
  it("skips trivial tasks without calling a model", async () => {
    const llm = fakeLlm(curated, "notes");
    const r = await analyzeSegment({ io: memoryIo(), llm, config: config(), segment: segment([]), messages: [], now: new Date() });
    expect(r.kind).toBe("skipped");
    expect(llm.calls).toEqual([]);
  });

  it("reflects, curates, writes ledger, views, proposals and a report", async () => {
    const io = memoryIo({ "package.json": '{"scripts":{"test:unit":"vitest run"}}', "src/export.ts": "x" });
    const llm = fakeLlm(curated, "COMMANDS: npm run test:unit");
    const r = await analyzeSegment({ io, llm, config: config(), segment: busyTask, messages: [{ role: "user", text: "fix the export" }], now: new Date("2026-10-21T10:00:00Z") });
    expect(llm.calls).toEqual(["reflect:[Archivist plugin — ", "complete:reflection"]);
    if (r.kind !== "done") throw new Error("expected a report");
    expect(r.report.applied.map((o) => o.type)).toEqual(["command", "decision"]);
    expect(r.report.proposals.map((o) => o.title)).toEqual(["Unsure"]);
    expect(statusLine(r.report)).toBe("📚 +2 entries · 1 to review · /archivist");
    expect(io.files.get(PATHS.coreRule)).toContain("`npm run test:unit`");
    expect([...io.files.keys()].some((k) => k.startsWith(".archivist/decisions/ADR-0001-"))).toBe(true);
    expect([...io.files.keys()].filter((k) => k.startsWith(PATHS.proposals))).toHaveLength(1);
    expect(io.files.get(r.reportPath)).toContain("Expected savings on a similar task:** ≈ 2 tool calls");
    expect(r.usage).toMatchObject({ cacheRead: 200_000, input: 3000 });
    expect((await loadState(io)).entries.size).toBe(2);
  });

  it("falls back to a digest when reflect is unavailable, and records a bad curator reply as an error", async () => {
    const io = memoryIo();
    const llm = fakeLlm("sorry, no JSON", "");
    const r = await analyzeSegment({ io, llm, config: config(), segment: busyTask, messages: [{ role: "user", text: "fix the export" }], now: new Date() });
    expect(llm.calls[1]).toBe("complete:digest");
    if (r.kind !== "done") throw new Error("expected a report");
    expect(r.report.analysis.error).toBe("reflect: nothing-to-fork; curate: reply was not JSON");
    expect(io.files.has(PATHS.ledger)).toBe(false);
  });
});

describe("scan", () => {
  it("seeds exact commands from manifests, with the right package manager", async () => {
    const io = memoryIo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", "lint:fix": "eslint --fix .", postinstall: "x", deploy: "y" } }),
      "pnpm-lock.yaml": "",
      Makefile: "build:\n\tgo build\n.PHONY: build\nCFLAGS:=1\n",
    });
    const ops = await scanCommands(io);
    expect(ops.map((o) => (o.op === "add" ? o.content : ""))).toEqual(["`pnpm test` — runs `vitest run`", "`pnpm lint:fix` — runs `eslint --fix .`", "`make build`"]);
    expect(scriptCommand("npm", "build")).toBe("npm run build");
    expect(scriptCommand("npm", "test")).toBe("npm test");
  });
});
