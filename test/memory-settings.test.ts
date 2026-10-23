import { describe, expect, it } from "vitest";
import type { Config } from "../src/core/config.js";
import { PATHS } from "../src/core/io.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { healthText } from "../src/core/maintenance.js";
import { memoryCachePath } from "../src/core/memory.js";
import { renderAll } from "../src/core/render.js";
import { config, entry, memoryIo } from "./helpers.js";

const now = new Date("2026-10-23T12:00:00.000Z");
const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const add = (e: ReturnType<typeof entry>) => ({ v: 1 as const, ts: e.created, op: "add" as const, entry: e });
const ruleFilesOff = (): Config => ({ ...config(), rules: { ...config().rules, files: false } });

describe("rule files off", () => {
  it("renders nothing Claude Code loads, removes what was generated before, and keeps the index and ADRs", async () => {
    const io = memoryIo();
    const entries = new Map(
      [
        entry({ id: "cmd-1", type: "command", title: "Full check", content: "`npm run check`" }),
        entry({ id: "gk-1", type: "gotcha", title: "Mod has no Node", content: "Use `$` for all I/O", scope: { paths: ["src/adapters/**"] } }),
        entry({ id: "dec-1", type: "decision", title: "Docs in Russian", content: "Write user docs in Russian.", rationale: "readers", adr: 1 }),
        entry({ id: "proc-1", type: "procedure", title: "Release", content: "1. npm run check\n2. npm version minor", rationale: "Use when releasing." }),
      ].map((e) => [e.id, e]),
    );
    await renderAll(io, entries, config());
    expect(io.files.has(PATHS.coreRule)).toBe(true);

    await renderAll(io, entries, ruleFilesOff());
    const paths = [...io.files.keys()];
    expect(paths.filter((p) => p.startsWith(`${PATHS.rulesDir}/`) || p.startsWith(`${PATHS.skillsDir}/archivist-`))).toEqual([]);
    expect(paths).toContain(PATHS.index);
    expect(paths.some((p) => p.startsWith(`${PATHS.decisions}/ADR-0001-`))).toBe(true);
  });
});

describe("health of the memory projection", () => {
  it("shows where entries went, what is missing or unknown there, and the last error", async () => {
    const io = memoryIo();
    await appendLedger(io, [add(entry({ id: "gk-1", type: "gotcha", title: "Alpha", content: "A fact", created: day(1) }))]);
    io.files.set(
      memoryCachePath("openviking"),
      JSON.stringify({
        store: "openviking",
        project: "github.com/beetrain/archivist",
        items: { "gk-1": { ref: "viking://resources/archivist/github.com/beetrain/archivist/gk-1.md", text: "x", updated: day(1) } },
        lastSync: day(0),
        lastError: "gk-2: server down",
        missing: ["gk-3"],
        unknown: ["gk-x", "gk-y"],
      }),
    );
    const text = await healthText(io, (await loadState(io)).entries, config(), now);
    const memory = text.split("## Memory\n")[1]!.split("\n\n")[0]!;
    expect(memory).toContain("openviking, project github.com/beetrain/archivist: 1 entries in memory");
    expect(memory).toContain("1 gone from memory");
    expect(memory).toContain("2 in memory that this ledger does not know");
    expect(memory).toContain("gk-2: server down");
    expect(text.split("## What to do\n")[1]).toContain("/archivist memory sync");
  });

  it("warns when rule files are off and nothing reaches a memory", async () => {
    const io = memoryIo();
    await appendLedger(io, [add(entry({ id: "gk-1", type: "gotcha", title: "Alpha", content: "A fact", created: day(1) }))]);
    const text = await healthText(io, (await loadState(io)).entries, ruleFilesOff(), now);
    expect(text.split("## What to do\n")[1]).toContain("rule files are off and no memory has received the entries");
  });

  it("does not take entries for unused when rule files are off, since nothing loads them", async () => {
    const io = memoryIo();
    const old = (id: string) => entry({ id, type: "gotcha", title: `Fact ${id}`, content: `A distinct fact number ${id}`, created: day(20) });
    await appendLedger(io, ["gk-1", "gk-2", "gk-3"].map((id) => add(old(id))));
    const on = await healthText(io, (await loadState(io)).entries, config(), now);
    const off = await healthText(io, (await loadState(io)).entries, ruleFilesOff(), now);
    expect(on).toContain("entries never met in a week");
    expect(off).not.toContain("entries never met in a week");
  });
});
