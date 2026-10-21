import { describe, expect, it } from "vitest";
import { parseOptions, splitArgs } from "../src/core/args.js";
import { PATHS } from "../src/core/io.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { renderAll } from "../src/core/render.js";
import { deprecateEntry, editEntry, editFromOptions } from "../src/core/review.js";
import { config, entry, memoryIo } from "./helpers.js";

const ts = "2026-10-22T10:00:00.000Z";

describe("args", () => {
  it("splits a command line with quotes and reads options", () => {
    const tokens = splitArgs(`edit gk-1 --title "Fork has no timeout" --content 'wrap it in \`Promise.race\`' --paths ""`);
    expect(tokens).toEqual(["edit", "gk-1", "--title", "Fork has no timeout", "--content", "wrap it in `Promise.race`", "--paths", ""]);
    const { words, opts } = parseOptions(tokens.slice(1));
    expect(words).toEqual(["gk-1"]);
    expect(editFromOptions(opts)).toEqual({ title: "Fork has no timeout", content: "wrap it in `Promise.race`", paths: [] });
    expect(parseOptions(["--paths"]).opts).toEqual({ paths: "true" });
    expect(splitArgs(`--reason "said \\"no\\" twice"`)).toEqual(["--reason", 'said "no" twice']);
  });
});

describe("edit and deprecate", () => {
  const scoped = entry({ id: "gk-1", type: "gotcha", title: "Fork: Fork has no timeout", content: "Fork: no timeout. Also fs.write makes dirs", scope: { paths: ["src/mod/**"] } });
  const cmd = entry({ id: "cmd-1", type: "command", title: "Tests", content: "`npm test`" });

  const setup = async () => {
    const io = memoryIo();
    await appendLedger(io, [scoped, cmd].map((e) => ({ v: 1 as const, ts, op: "add" as const, entry: e })));
    await renderAll(io, (await loadState(io)).entries, config());
    return io;
  };

  it("fixes an entry in place and re-renders the rule it lives in", async () => {
    const io = await setup();
    expect(io.files.get(".claude/rules/archivist/src-mod.md")).toContain("Fork: Fork has no timeout");
    const r = await editEntry(io, config(), "gk-1", { title: "Fork has no timeout", content: "Wrap `$.model.fork` in `Promise.race` with `$.clock.sleep`" }, ts);
    expect(r).toMatchObject({ ok: true, entry: { title: "Fork has no timeout", updated: ts } });
    expect(io.files.get(".claude/rules/archivist/src-mod.md")).toContain("**Fork has no timeout**: Wrap `$.model.fork`");
  });

  it("clears a scope, moving the fact to the always-loaded rule and pruning the emptied file", async () => {
    const io = await setup();
    const r = await editEntry(io, config(), "gk-1", { paths: [] }, ts);
    expect(r.ok && [r.written, r.removed]).toEqual([[PATHS.coreRule, PATHS.index], [".claude/rules/archivist/src-mod.md"]]);
    expect(io.files.has(".claude/rules/archivist/src-mod.md")).toBe(false);
    expect(io.files.get(PATHS.coreRule)).toContain("Fork: Fork has no timeout");
  });

  it("masks a secret typed into an edit", async () => {
    const io = await setup();
    await editEntry(io, config(), "cmd-1", { content: "`npm test` with API_KEY=abcdef123456" }, ts);
    expect((await loadState(io)).entries.get("cmd-1")?.content).toBe("`npm test` with API_KEY=[redacted]");
  });

  it("retires an entry with a reason, and refuses what it cannot do", async () => {
    const io = await setup();
    expect(await deprecateEntry(io, config(), "cmd-1", "", ts)).toEqual({ ok: false, reason: "say why: --reason" });
    const r = await deprecateEntry(io, config(), "cmd-1", "replaced by make test", ts);
    expect(r).toMatchObject({ ok: true, entry: { status: "deprecated", deprecatedReason: "replaced by make test" } });
    expect(io.files.get(PATHS.coreRule)).not.toContain("`npm test`");
    expect(await editEntry(io, config(), "cmd-1", { title: "x" }, ts)).toEqual({ ok: false, reason: "no active entry cmd-1" });
    expect(await editEntry(io, config(), "gk-1", { title: scoped.title }, ts)).toEqual({ ok: false, reason: "nothing to change" });
  });
});
