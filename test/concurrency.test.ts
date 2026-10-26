import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { afterFailure } from "../src/core/attempts.js";
import { PATHS, type Io, type Llm, type Mutex } from "../src/core/io.js";
import { loadState, parseLedger } from "../src/core/ledger.js";
import { LOCK, STALE_MS, withLock } from "../src/core/lock.js";
import { loadMetrics } from "../src/core/metrics.js";
import { addEntry, applyProposals, listProposals } from "../src/core/review.js";
import { loadUsage } from "../src/core/usage.js";
import { nodeIo } from "../src/cli/node-io.js";
import { config, memoryIo, segment } from "./helpers.js";

const memoryMutex = () => {
  let clock = 0;
  const held = new Map<string, number>();
  const m: Mutex & { held: Map<string, number>; at: (t: number) => void } = {
    held,
    at: (t) => (clock = t),
    async claim(p) {
      if (held.has(p)) return false;
      held.set(p, clock);
      return true;
    },
    async age(p) {
      const t = held.get(p);
      return t === undefined ? undefined : clock - t;
    },
    async release(p) {
      held.delete(p);
    },
    async sleep(ms) {
      clock += ms;
      await Promise.resolve();
    },
  };
  return m;
};

const edit = segment([{ tool: "Edit", target: "src/a.ts", ok: true }]);
const now = new Date("2026-10-22T12:00:00Z");
const reply = (ops: unknown[]) => JSON.stringify({ summary: "", ops });

describe("withLock", () => {
  it("runs one writer at a time and releases the lock after a failure", async () => {
    const mutex = memoryMutex();
    const io: Io = { ...memoryIo(), mutex };
    const order: string[] = [];
    const writer = (name: string) =>
      withLock(io, async () => {
        order.push(`${name} in`);
        await mutex.sleep(5);
        order.push(`${name} out`);
      });
    await Promise.all([writer("a"), writer("b")]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
    await expect(withLock(io, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(mutex.held.size).toBe(0);
  });

  it("breaks a lock left by a crashed writer, and gives up on a live one", async () => {
    const mutex = memoryMutex();
    const io: Io = { ...memoryIo(), mutex };
    await mutex.claim(LOCK);
    mutex.at(STALE_MS + 1);
    expect(await withLock(io, async () => "ran")).toBe("ran");

    await mutex.claim(LOCK);
    await expect(withLock(io, async () => "ran", 1000)).rejects.toThrow(`${LOCK} is held by another Archivist writer`);
  });

  it("runs unlocked where the Io has no mutex", async () => {
    expect(await withLock(memoryIo(), async () => 1)).toBe(1);
  });
});

describe("writers in parallel on disk", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps every record and numbers every ADR once", async () => {
    dir = await mkdtemp(join(tmpdir(), "archivist-lock-"));
    const io = nodeIo(dir);
    const decisions = [
      ["Releases from main", "Cut every release from the main branch", "one line of history"],
      ["Docs in Russian", "Write user documentation in Russian", "readers speak it"],
      ["Vitest for tests", "Unit suites run under vitest", "fast watch mode"],
      ["No runtime dependencies", "Ship the plugin without npm packages", "marketplace installs build nothing"],
      ["Ledger is append-only", "Never rewrite past ledger lines", "history explains retirements"],
      ["Haiku curates", "The cheap model turns notes into operations", "cost per task"],
      ["Quiet reports", "Report through the status line, not a turn", "a turn costs tokens"],
      ["Local metrics", "Per-task numbers stay out of git", "they churn every task"],
    ];
    await Promise.all(decisions.map(([title, content, why]) => addEntry(io, config(), { type: "decision", title: title!, content: content!, rationale: why! }, now.toISOString())));
    const entries = [...(await loadState(io)).entries.values()];
    expect(entries).toHaveLength(decisions.length);
    expect(entries.map((e) => e.adr).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await io.exists(LOCK)).toBe(false);
  });
});

describe("analysis against a base that changed meanwhile", () => {
  it("validates against what another writer recorded while the models ran", async () => {
    const io = memoryIo();
    const llm: Llm = {
      async complete() {
        await addEntry(io, config(), { type: "decision", title: "Docs in Russian", content: "Write the docs in Russian", rationale: "the rest is" }, now.toISOString());
        await addEntry(io, config(), { type: "gotcha", title: "Flaky login test", content: "Retry the login e2e test once before failing" }, now.toISOString());
        return {
          ok: true,
          text: reply([
            { op: "add", type: "decision", title: "Releases from main only", content: "Cut releases from main", rationale: "one line of history", confidence: 0.9 },
            { op: "add", type: "gotcha", title: "Flaky login test", content: "Retry the login e2e test once before failing", confidence: 0.9 },
          ]),
          usage: {},
        };
      },
    };
    const r = await analyzeSegment({ io, llm, config: config(), segment: edit, now });
    if (r.kind !== "done") throw new Error("expected a report");
    const entries = [...(await loadState(io)).entries.values()];
    expect(entries.filter((e) => e.type === "decision").map((e) => e.adr).sort()).toEqual([1, 2]);
    expect(entries.filter((e) => e.type === "gotcha")).toHaveLength(1);
    expect(r.report.applied.find((o) => o.op.op === "reinforce")?.reason).toBe("duplicate of existing entry");
  });
});

describe("a retried analysis", () => {
  const curator: Llm = {
    async complete() {
      return { ok: true, text: reply([{ op: "add", type: "gotcha", title: "Flaky login test", content: "Retry the login e2e test once before failing", confidence: 0.9 }]), usage: {} };
    },
  };

  it("does not write twice what a run that threw after the ledger write wrote", async () => {
    const raw = memoryIo();
    let failReport = true;
    const io: Io = {
      ...raw,
      async write(p, t) {
        if (failReport && p.startsWith(PATHS.reports)) {
          failReport = false;
          throw new Error("disk full");
        }
        await raw.write(p, t);
      },
    };
    await expect(analyzeSegment({ io, llm: curator, config: config(), segment: edit, now })).rejects.toThrow("disk full");
    raw.files.delete(PATHS.coreRule);

    const r = await analyzeSegment({ io, llm: curator, config: config(), segment: edit, now });
    expect(r).toMatchObject({ kind: "skipped", reason: "already analysed" });
    expect(parseLedger(raw.files.get(PATHS.ledger)!).records).toHaveLength(1);
    expect(await loadMetrics(io)).toHaveLength(1);
    expect(raw.files.get(PATHS.coreRule)).toContain("Flaky login test");
  });

  it("measures the task once when it threw before writing anything", async () => {
    const io = memoryIo({ "package.json": "{}" });
    let calls = 0;
    const flaky: Llm = {
      async complete(req) {
        if (!calls++) throw new Error("connection reset");
        return curator.complete(req);
      },
    };
    const used = { ...edit, tools: [...edit.tools, { tool: "Bash", target: "npm test", ok: true }] };
    await addEntry(io, config(), { type: "command", title: "Tests", content: "`npm test` runs the suite" }, now.toISOString());
    const id = [...(await loadState(io)).entries.keys()][0]!;
    await expect(analyzeSegment({ io, llm: flaky, config: config(), segment: used, now })).rejects.toThrow("connection reset");
    const r = await analyzeSegment({ io, llm: flaky, config: config(), segment: used, now });
    expect(r.kind).toBe("done");
    expect(await loadMetrics(io)).toHaveLength(1);
    expect((await loadUsage(io))[id]?.used).toBe(1);
  });

  it("is given up after the third failure", () => {
    expect(afterFailure()).toEqual({ failures: 1, drop: false });
    expect(afterFailure(1)).toEqual({ failures: 2, drop: false });
    expect(afterFailure(2)).toEqual({ failures: 3, drop: true });
  });
});

describe("review against a queue that changed meanwhile", () => {
  it("does not apply a proposal another writer settled", async () => {
    const io = memoryIo();
    const op = { op: "add", type: "gotcha", title: "Flaky login test", content: "Retry the login e2e test once before failing", confidence: 0.5 };
    io.files.set(`${PATHS.proposals}/p1.json`, JSON.stringify({ ts: now.toISOString(), op, reason: null }));
    const chosen = await listProposals(io);
    io.files.delete(`${PATHS.proposals}/p1.json`);
    expect(await applyProposals(io, config(), chosen, now.toISOString())).toEqual([]);
    expect(io.files.has(PATHS.ledger)).toBe(false);
  });
});
