import { describe, expect, it } from "vitest";
import { PATHS } from "../src/core/io.js";
import { foldLedger, parseLedger } from "../src/core/ledger.js";
import { renderCore, renderViews, writeViews } from "../src/core/render.js";
import { bm25, globToRegExp, jaccard, slug } from "../src/core/text.js";
import type { LedgerRecord } from "../src/core/types.js";
import { validateOps } from "../src/core/validate.js";
import { config, entry, memoryIo } from "./helpers.js";

const ts = "2026-10-21T10:00:00.000Z";

describe("ledger", () => {
  it("folds add, update, reinforce, deprecate and supersedes", () => {
    const a = entry({ id: "cmd-a", type: "command", title: "Tests", content: "`npm test`" });
    const b = entry({ id: "cmd-b", type: "command", title: "Tests fast", content: "`npm test -- --run`", supersedes: ["cmd-a"] });
    const records: LedgerRecord[] = [
      { v: 1, ts, op: "add", entry: a },
      { v: 1, ts, op: "reinforce", id: "cmd-a" },
      { v: 1, ts, op: "update", id: "cmd-a", patch: { content: "`npm test --silent`" } },
      { v: 1, ts, op: "add", entry: b },
      { v: 1, ts, op: "deprecate", id: "missing", reason: "x" },
    ];
    const s = foldLedger(records);
    expect(s.get("cmd-a")).toMatchObject({ reinforced: 1, content: "`npm test --silent`", status: "deprecated", deprecatedReason: "superseded by cmd-b" });
    expect(s.get("cmd-b")?.status).toBe("active");
    expect(s.has("missing")).toBe(false);
  });

  it("keeps unreadable lines out of the state and reports them", () => {
    const { records, badLines } = parseLedger(`{"v":1,"ts":"x","op":"reinforce","id":"a"}\nnot json\n\n{"v":2}\n`);
    expect(records).toHaveLength(1);
    expect(badLines).toEqual([2, 4]);
  });
});

describe("text", () => {
  it("matches globs, scores relevance, compares and slugs", () => {
    expect(globToRegExp("src/db/**").test("src/db/migrations/001.sql")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(bm25(["run vitest for tests", "deploy with docker"], "tests vitest")[0]?.index).toBe(0);
    expect(jaccard("run `pnpm test` for tests", "Run pnpm test for tests")).toBe(1);
    expect(slug("Стриминг CSV, не в памяти!")).toBe("стриминг-csv-не-в-памяти");
  });
});

describe("validateOps", () => {
  const base = { now: ts, docs: [] as string[], src: { segment: "seg1" } };

  it("applies confident adds, reinforces duplicates instead of adding them", async () => {
    const io = memoryIo({ "package.json": "{}" });
    const existing = new Map([["cmd-a", entry({ id: "cmd-a", type: "command", title: "Run tests", content: "Use `pnpm vitest run <path>` for one module" })]]);
    const v = await validateOps({
      ...base,
      io,
      config: config(),
      entries: existing,
      ops: [
        { op: "add", type: "command", title: "Run tests", content: "Use `pnpm vitest run <path>` for one module", confidence: 0.9 },
        { op: "add", type: "gotcha", title: "Migrations are generated", content: "Never edit src/db/migrations by hand; run `pnpm db:gen`", evidence: [{ file: "package.json" }], confidence: 0.9 },
      ],
    });
    expect(v.records.map((r) => r.op)).toEqual(["reinforce", "add"]);
    expect(v.applied[1]).toMatchObject({ type: "gotcha", title: "Migrations are generated" });
    const added = v.records[1];
    expect(added?.op === "add" && added.entry.evidence).toEqual([{ file: "package.json" }]);
  });

  it("routes doubtful ops to review and drops what docs already say", async () => {
    const io = memoryIo();
    const v = await validateOps({
      ...base,
      io,
      config: config(),
      entries: new Map(),
      docs: ["# Dev\n\nRun the tests with `make test` before every commit."],
      ops: [
        { op: "add", type: "command", title: "Run the tests", content: "Run the tests with `make test` before every commit", confidence: 0.95 },
        { op: "add", type: "gotcha", title: "Cache dir", content: "Clear .cache before e2e", evidence: [{ file: "nope.ts" }], confidence: 0.9 },
        { op: "add", type: "decision", title: "Stream CSV", content: "Stream the CSV export", confidence: 0.95 },
        { op: "deprecate", id: "nope", reason: "x", confidence: 1 },
      ],
    });
    expect(v.rejected.map((r) => r.reason)).toEqual(["already in project docs", "no active entry nope"]);
    expect(v.proposals.map((p) => p.title)).toEqual(["Cache dir", "Stream CSV"]);
    expect(v.proposals[0]?.reason).toContain("evidence file not found");
    expect(v.records).toHaveLength(0);
  });

  it("numbers decisions and needs a high bar to deprecate", async () => {
    const io = memoryIo();
    const existing = new Map([["gk-a", entry({ id: "gk-a", type: "gotcha", title: "Old", content: "old fact" })]]);
    const v = await validateOps({
      ...base,
      io,
      config: config(),
      entries: existing,
      ops: [
        { op: "add", type: "decision", title: "Stream CSV", content: "Stream exports", rationale: "files exceed 1 GB", confidence: 0.9 },
        { op: "deprecate", id: "gk-a", reason: "maybe stale", confidence: 0.85 },
      ],
    });
    const add = v.records[0];
    expect(add?.op === "add" && add.entry.adr).toBe(1);
    expect(v.proposals[0]).toMatchObject({ id: "gk-a", reason: "maybe stale" });
  });
});

describe("render", () => {
  it("keeps the always-loaded rule within budget and points to the index", () => {
    const entries = Array.from({ length: 80 }, (_, i) => entry({ id: `cmd-${i}`, type: "command", title: `C${i}`, content: `\`run ${i}\`` }));
    const text = renderCore(entries, config());
    expect(text.split("\n").length - 1).toBeLessThanOrEqual(60);
    expect(text).toMatch(/\d+ more in `\.archivist\/INDEX\.md`/);
  });

  it("renders ADRs and writes only files that changed", async () => {
    const dec = entry({ id: "dec-a", type: "decision", title: "Stream CSV", content: "Stream exports", rationale: "1 GB files", adr: 7 });
    const views = renderViews(new Map([["dec-a", dec]]), config());
    const adr = [...views.keys()].find((k) => k.startsWith(PATHS.decisions));
    expect(adr).toBe(".archivist/decisions/ADR-0007-stream-csv.md");
    expect(views.get(adr!)).toContain("## Context\n\n1 GB files");
    expect(views.get(PATHS.coreRule)).toContain("ADR-0007 **Stream CSV**: Stream exports");
    const io = memoryIo();
    expect(await writeViews(io, views)).toHaveLength(3);
    expect(await writeViews(io, views)).toHaveLength(0);
  });
});
