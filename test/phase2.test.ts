import { describe, expect, it } from "vitest";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { PATHS, type Llm } from "../src/core/io.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { isExcluded, redact } from "../src/core/privacy.js";
import { renderAll, renderAreas, renderCore } from "../src/core/render.js";
import { addEntry, applyProposals, listProposals, loadSkipped, pick, skipProposals } from "../src/core/review.js";
import { validateOps } from "../src/core/validate.js";
import { scanCommands } from "../src/cli/scan.js";
import { config, entry, memoryIo, segment } from "./helpers.js";

const ts = "2026-10-21T10:00:00.000Z";

describe("privacy", () => {
  it("masks secret values and token shapes, keeps names, types and references", () => {
    const r = redact(
      "API_KEY=abcd1234efgh token: ${TOKEN} password: string ghp_" + "a".repeat(36) + " postgres://user:hunter22@db/x",
    );
    expect(r.text).toBe("API_KEY=[redacted] token: ${TOKEN} password: string [redacted] postgres://[redacted]@db/x");
    expect(r.count).toBe(3);
    expect(isExcluded(".env.local", config().privacy.excludePaths)).toBe(true);
    expect(isExcluded("app/config/.env", config().privacy.excludePaths)).toBe(true);
    expect(isExcluded("src/env.ts", config().privacy.excludePaths)).toBe(false);
  });

  it("sends an entry that needed a secret to review, masked, and never cites an excluded file", async () => {
    const io = memoryIo({ ".env": "X=1", "src/a.ts": "" });
    const v = await validateOps({
      ops: [{ op: "add", type: "gotcha", title: "Staging DB", content: "Connect with DB_PASSWORD=s3cr3tpass", evidence: [{ file: ".env" }, { file: "src/a.ts" }], confidence: 0.95 }],
      entries: new Map(),
      io,
      config: config(),
      docs: [],
      now: ts,
    });
    expect(v.records).toHaveLength(0);
    expect(v.proposals[0]).toMatchObject({ reason: "secrets redacted" });
    const op = v.proposals[0]!.op;
    expect(op.op === "add" && op.content).toBe("Connect with DB_PASSWORD=[redacted]");
  });
});

describe("path-scoped rules and stale entries", () => {
  const gk = entry({ id: "gk-db", type: "gotcha", title: "Generated migrations", content: "Run `pnpm db:gen`", scope: { paths: ["src/db/**"] }, evidence: [{ file: "package.json" }] });
  const cmd = entry({ id: "cmd-t", type: "command", title: "Tests", content: "`pnpm test`", evidence: [{ file: "package.json" }] });
  const gone = entry({ id: "gk-old", type: "gotcha", title: "Old helper", content: "Use legacy.ts", evidence: [{ file: "src/legacy.ts" }] });

  it("puts scoped facts in their own rule file with paths frontmatter, the rest in core", () => {
    const areas = renderAreas([gk, cmd], config());
    expect([...areas.keys()]).toEqual([".claude/rules/archivist/src-db.md"]);
    expect(areas.get(".claude/rules/archivist/src-db.md")).toMatch(/^---\npaths:\n {2}- "src\/db\/\*\*"\n---\n<!-- Generated/);
    const core = renderCore([gk, cmd], config());
    expect(core).toContain("`pnpm test`");
    expect(core).not.toContain("db:gen");
  });

  it("keeps stale entries out of the rules and prunes files it no longer produces", async () => {
    const io = memoryIo({ "package.json": "{}" });
    await appendLedger(io, [gk, cmd, gone].map((e) => ({ v: 1 as const, ts, op: "add" as const, entry: e })));
    const first = await renderAll(io, (await loadState(io)).entries, config());
    expect([...first.stale]).toEqual(["gk-old"]);
    expect(io.files.get(PATHS.coreRule)).not.toContain("legacy");
    expect(io.files.get(PATHS.index)).toContain("`gk-old` gotcha: Old helper ⚠ stale");

    await appendLedger(io, [{ v: 1, ts, op: "deprecate", id: "gk-db", reason: "moved" }]);
    const second = await renderAll(io, (await loadState(io)).entries, config());
    expect(second.removed).toEqual([".claude/rules/archivist/src-db.md"]);
    io.files.set(".claude/rules/archivist/mine.md", "hand-written rule");
    expect((await renderAll(io, (await loadState(io)).entries, config())).removed).toEqual([]);
  });
});

describe("review", () => {
  const proposal = (n: number, title: string) => [
    `${PATHS.proposals}/2026-10-21T10-00-00-000Z-${n}.json`,
    JSON.stringify({ ts, src: { segment: "s" }, op: { op: "add", type: "gotcha", title, content: `${title} details here`, confidence: 0.6 }, reason: null }),
  ];

  it("applies chosen proposals past the thresholds and forgets skipped ideas for good", async () => {
    const io = memoryIo(Object.fromEntries([proposal(0, "Cache dir"), proposal(1, "Flaky e2e retries")]));
    const all = await listProposals(io);
    expect(all.map((p) => p.n)).toEqual([1, 2]);
    const applied = await applyProposals(io, config(), pick(all, "1"), ts);
    expect(applied[0]).toMatchObject({ title: "Cache dir", type: "gotcha" });
    expect((await loadState(io)).entries.size).toBe(1);
    expect(io.files.get(PATHS.coreRule)).toContain("Cache dir");

    await skipProposals(io, pick(await listProposals(io), "all"), ts);
    expect(await listProposals(io)).toHaveLength(0);
    expect(await loadSkipped(io)).toEqual(["Flaky e2e retries Flaky e2e retries details here"]);
    const again = await validateOps({
      ops: [{ op: "add", type: "gotcha", title: "Flaky e2e retries", content: "Flaky e2e retries details here", confidence: 0.99 }],
      entries: new Map(),
      io,
      config: config(),
      docs: [],
      now: ts,
      skipped: await loadSkipped(io),
    });
    expect(again.rejected[0]?.reason).toBe("skipped in an earlier review");
  });

  it("records a decision by hand as an ADR", async () => {
    const io = memoryIo({ "src/export.ts": "" });
    const out = await addEntry(io, config(), { type: "decision", title: "Stream CSV exports", content: "Export as a stream", rationale: "files exceed 1 GB; buffering was rejected", evidence: ["src/export.ts"] }, ts);
    expect(out[0]).toMatchObject({ type: "decision" });
    expect(io.files.get(".archivist/decisions/ADR-0001-stream-csv-exports.md")).toContain("files exceed 1 GB");
    const e = [...(await loadState(io)).entries.values()][0];
    expect(e).toMatchObject({ source: "user", confidence: 1 });
  });
});

describe("pipeline cost controls", () => {
  it("skips the fork above the context threshold and redacts the digest", async () => {
    const calls: string[] = [];
    const llm: Llm = {
      async reflect() {
        calls.push("reflect");
        return { ok: true, text: "notes", usage: {} };
      },
      async complete({ prompt }) {
        calls.push(prompt.includes("sk-ant-") ? "leaked" : "clean");
        return { ok: true, text: '{"summary":"","ops":[]}', usage: {} };
      },
    };
    const seg = segment([
      { tool: "Bash", target: "npm test", ok: false, error: "boom" },
      { tool: "Edit", target: "src/a.ts", ok: true },
    ]);
    const r = await analyzeSegment({
      io: memoryIo(),
      llm,
      config: config(),
      segment: seg,
      messages: [{ role: "user", text: "fix the export with key sk-ant-" + "x".repeat(30) }],
      contextTokens: 400_000,
      now: new Date(ts),
    });
    expect(calls).toEqual(["clean"]);
    if (r.kind !== "done") throw new Error("expected a report");
    expect(r.report.analysis.note).toBe("reflect skipped: context 400000 tokens > 300000");
  });
});

describe("scan language", () => {
  it("titles seeded commands in the configured language", async () => {
    const ops = await scanCommands(memoryIo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }), "Russian");
    expect(ops[0]).toMatchObject({ title: "Запуск тестов", content: "`npm test` — запускает `vitest run`" });
  });
});
