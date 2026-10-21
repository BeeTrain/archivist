import { describe, expect, it } from "vitest";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { PATHS, type Llm } from "../src/core/io.js";
import { loadState } from "../src/core/ledger.js";
import { METRICS } from "../src/core/metrics.js";
import { expireProposals, listProposals, needsHuman, pick, reviewJson } from "../src/core/review.js";
import type { ProposedOp } from "../src/core/types.js";
import { validateOps } from "../src/core/validate.js";
import { config, memoryIo, segment } from "./helpers.js";

const ts = "2026-10-22T10:00:00.000Z";
const gotcha = (title: string, content: string, confidence = 0.6): ProposedOp => ({ op: "add", type: "gotcha", title, content, confidence });
const proposalFile = (name: string, op: ProposedOp, at = ts) => [`${PATHS.proposals}/${name}.json`, JSON.stringify({ ts: at, op, reason: null })];

describe("queue for triage", () => {
  it("lists proposals with stable ids and says who decides", async () => {
    const io = memoryIo(
      Object.fromEntries([
        proposalFile("a-0", gotcha("Cache dir", "Clear .cache before e2e runs")),
        proposalFile("a-1", { op: "add", type: "decision", title: "Stream CSV", content: "Stream exports", rationale: "1 GB files", confidence: 0.7 }),
        proposalFile("a-2", { op: "deprecate", id: "cmd-x", reason: "stale", confidence: 0.7 }),
      ]),
    );
    const all = await listProposals(io);
    expect(pick(all, "a-1").map((p) => p.n)).toEqual([2]);
    expect(pick(all, "1,a-2").map((p) => p.id)).toEqual(["a-0", "a-2"]);
    expect(all.map((p) => needsHuman(p.op))).toEqual([false, true, true]);
    expect(JSON.parse(reviewJson(all))[0]).toMatchObject({ id: "a-0", n: 1, ts, human: false, op: { title: "Cache dir" } });
  });
});

describe("expiry", () => {
  it("drops proposals left unreviewed for too long or too many tasks, and keeps fresh ones", async () => {
    const io = memoryIo(
      Object.fromEntries([
        proposalFile("old", gotcha("Old", "an old idea"), "2026-10-01T00:00:00.000Z"),
        proposalFile("busy", gotcha("Busy", "many tasks since"), "2026-10-21T00:00:00.000Z"),
        proposalFile("fresh", gotcha("Fresh", "just proposed"), "2026-10-22T09:00:00.000Z"),
      ]),
    );
    const task = (at: string) => JSON.stringify({ ts: at, source: "live", toolCalls: 3 });
    io.files.set(METRICS, Array.from({ length: 20 }, (_, i) => task(`2026-10-21T12:${String(i).padStart(2, "0")}:00.000Z`)).join("\n") + "\n");
    const gone = await expireProposals(io, config(), new Date(ts));
    expect(gone.map((p) => p.id)).toEqual(["busy", "old"]);
    expect((await listProposals(io)).map((p) => p.id)).toEqual(["fresh"]);
  });
});

describe("promotion on repeat", () => {
  const first = gotcha("npm run check не обновляет копию мода", "`npm run check` пересобирает `plugin/`, но не копирует его в dev-копию мода: синхронизировать через `rsync`.");
  const again = gotcha("Копия мода не обновляется после check", "После `npm run check` dev-копия мода остаётся старой, нужно синхронизировать её через `rsync`.");
  const base = { entries: new Map(), config: config(), docs: [] as string[], now: ts };

  it("applies a technical fact proposed again while the first proposal waits", async () => {
    const v = await validateOps({ ...base, ops: [again], io: memoryIo(), pending: [{ id: "p-0", op: first }] });
    expect(v.records).toHaveLength(1);
    expect(v.applied[0]).toMatchObject({ type: "gotcha", reason: "proposed again in a later task" });
    expect(v.promoted).toEqual(["p-0"]);
  });

  it("leaves decisions, unrelated facts and facts with masked secrets waiting", async () => {
    const decision: ProposedOp = { op: "add", type: "decision", title: "Stream CSV exports", content: "Export CSV as a stream", rationale: "files over 1 GB", confidence: 0.6 };
    const secret = gotcha("Staging DB", "Connect with DB_PASSWORD=hunter2hunter2 to staging-db");
    const v = await validateOps({
      ...base,
      ops: [decision, gotcha("Flaky e2e", "Retry the login e2e test once"), secret],
      io: memoryIo(),
      pending: [
        { id: "d", op: decision },
        { id: "s", op: secret },
        { id: "x", op: first },
      ],
    });
    expect(v.records).toHaveLength(0);
    expect(v.proposals).toHaveLength(3);
    expect(v.promoted).toEqual([]);
  });

  it("removes the settled proposal from the queue when the analyzer sees the fact again", async () => {
    const io = memoryIo(Object.fromEntries([proposalFile("p-0", first, "2026-10-22T09:00:00.000Z")]));
    const llm: Llm = {
      async complete() {
        return { ok: true, text: JSON.stringify({ summary: "", ops: [again] }), usage: {} };
      },
    };
    const task = segment([
      { tool: "Bash", target: "npm run check", ok: true },
      { tool: "Edit", target: "src/a.ts", ok: true },
    ]);
    await analyzeSegment({ io, llm, config: config(), segment: task, now: new Date(ts) });
    expect(await listProposals(io)).toEqual([]);
    expect([...(await loadState(io)).entries.values()].map((e) => e.title)).toEqual(["Копия мода не обновляется после check"]);
  });
});
