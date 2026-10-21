import { describe, expect, it } from "vitest";
import { analyzeSegment } from "../src/analyzer/pipeline.js";
import { PATHS, withLocalIgnored, type Llm } from "../src/core/io.js";
import { LOG_LINES, logKey, withLine } from "../src/core/log.js";
import { config, memoryIo, segment } from "./helpers.js";

describe(".archivist/.gitignore without archivist init", () => {
  it("is created before the first write under .archivist/, once", async () => {
    const raw = memoryIo();
    const io = withLocalIgnored(raw);
    await io.write("src/a.ts", "x");
    expect(raw.files.has(PATHS.gitignore)).toBe(false);
    await io.write(".archivist/.local/metrics.jsonl", "{}\n");
    expect(raw.files.get(PATHS.gitignore)).toBe(".local/\n");
    raw.files.set(PATHS.gitignore, "custom\n");
    await io.write(".archivist/ledger.jsonl", "");
    expect(raw.files.get(PATHS.gitignore)).toBe("custom\n");
  });

  it("adds a .local/ line to someone's own .gitignore, and leaves one that has it alone", async () => {
    const mine = memoryIo({ [PATHS.gitignore]: "*.tmp" });
    await withLocalIgnored(mine).write(".archivist/ledger.jsonl", "");
    expect(mine.files.get(PATHS.gitignore)).toBe("*.tmp\n.local/\n");
    const ok = memoryIo({ [PATHS.gitignore]: "/.local\n*.tmp\n" });
    await withLocalIgnored(ok).write(".archivist/ledger.jsonl", "");
    expect(ok.files.get(PATHS.gitignore)).toBe("/.local\n*.tmp\n");
  });

  it("guards the first analysed task in a fresh project, even a trivial one", async () => {
    const raw = memoryIo();
    const llm: Llm = {
      async complete() {
        return { ok: true, text: '{"summary":"","ops":[]}', usage: {} };
      },
    };
    const r = await analyzeSegment({ io: withLocalIgnored(raw), llm, config: config(), segment: segment([{ tool: "Read", target: "a", ok: true }]), now: new Date() });
    expect(r.kind).toBe("skipped");
    expect(raw.files.has(".archivist/.local/metrics.jsonl")).toBe(true);
    expect(raw.files.get(PATHS.gitignore)).toBe(".local/\n");
  });
});

describe("log per project", () => {
  it("keys each project's log apart and keeps the newest lines", () => {
    expect(logKey("/work/a")).not.toBe(logKey("/work/b"));
    const at = new Date("2026-10-22T10:00:00.000Z");
    let lines: string[] | undefined;
    for (let i = 0; i < LOG_LINES + 5; i++) lines = withLine(lines, `line ${i}`, at);
    expect(lines).toHaveLength(LOG_LINES);
    expect(lines![0]).toBe("2026-10-22T10:00:00.000Z line 5");
    expect(lines!.at(-1)).toBe(`2026-10-22T10:00:00.000Z line ${LOG_LINES + 4}`);
  });
});
