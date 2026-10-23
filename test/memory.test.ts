import { describe, expect, it } from "vitest";
import { appendLedger } from "../src/core/ledger.js";
import { clearMemory, loadMemoryCache, memoryUpToDate, projectId, readSignature, reconcile, renderItem, syncMemory, type MemoryCache } from "../src/core/memory.js";
import type { Entry } from "../src/core/types.js";
import { entry, fakeMemoryStore, memoryIo } from "./helpers.js";

const project = "github.com/beetrain/archivist";
const ts = "2026-10-23T10:00:00.000Z";
const later = "2026-10-23T12:00:00.000Z";

const gotcha = entry({
  id: "gk-1",
  type: "gotcha",
  title: "Mod code has no Node types",
  content: "Typecheck it with `tsc -p tsconfig.mod.json`",
  rationale: "the mods runtime has no Node",
  scope: { paths: ["src/adapters/**"] },
  created: ts,
  updated: ts,
});
const command = entry({ id: "cmd-1", type: "command", title: "Full check", content: "`npm run check` runs types, tests and the build", created: ts, updated: ts });

const ledger = (...entries: Entry[]) => new Map(entries.map((e) => [e.id, e]));
const emptyCache = (): MemoryCache => ({ store: "fake", project, items: {} });

describe("projectId", () => {
  it.each([
    ["git@github.com:BeeTrain/archivist.git", "github.com/beetrain/archivist"],
    ["https://github.com/BeeTrain/archivist.git", "github.com/beetrain/archivist"],
    ["ssh://git@git.example.com:2222/team/app", "git.example.com/team/app"],
    ["https://user:s3cret@gitlab.example.com:8443/group/sub/repo.git", "gitlab.example.com/group/sub/repo"],
  ])("names %s as %s", (remote, id) => {
    expect(projectId(remote, "/work/x")).toBe(id);
  });

  it("falls back to the folder name without a remote", () => {
    expect(projectId(undefined, "/Users/me/My Project")).toBe("local/my-project");
  });
});

describe("an item in memory", () => {
  it("states the fact on its own and signs it with project, id and last change", () => {
    expect(renderItem(gotcha, project)).toBe(
      [
        "# Mod code has no Node types",
        "",
        "Gotcha: Typecheck it with `tsc -p tsconfig.mod.json`",
        "Why: the mods runtime has no Node",
        "Where: src/adapters/**",
        "",
        "Project: github.com/beetrain/archivist · Archivist gk-1 · updated 2026-10-23T10:00:00.000Z",
        "",
      ].join("\n"),
    );
  });

  it("keeps a procedure's steps on their own lines and a decision's ADR number", () => {
    const procedure = entry({ id: "proc-1", type: "procedure", title: "Release", content: "1. npm run check\n2. npm version minor", created: ts, updated: ts });
    const decision = entry({ id: "dec-1", type: "decision", title: "Docs in Russian", content: "Write user docs in Russian.", adr: 7, created: ts, updated: ts });
    expect(renderItem(procedure, project)).toContain("Procedure:\n1. npm run check\n2. npm version minor\n");
    expect(renderItem(decision, project)).toContain("Project: github.com/beetrain/archivist · Archivist dec-1 · ADR-0007 · updated 2026-10-23T10:00:00.000Z");
  });

  it("reads the signature back, and finds none in text Archivist did not write", () => {
    expect(readSignature(renderItem(gotcha, project))).toEqual({ project, id: "gk-1", updated: ts });
    expect(readSignature("# Notes\n\nSomething a person wrote\n")).toBeUndefined();
  });
});

describe("reconcile", () => {
  const sync = (store: ReturnType<typeof fakeMemoryStore>, entries: Map<string, Entry>, cache = emptyCache(), stale = new Set<string>(), verify = false) =>
    reconcile({ store: store.store, entries, stale, cache, verify });

  it("writes active entries the first time and remembers what it sent", async () => {
    const fake = fakeMemoryStore(project);
    const { cache, outcome } = await sync(fake, ledger(gotcha, command));
    expect(outcome.written.sort()).toEqual(["cmd-1", "gk-1"]);
    expect(fake.items.get(fake.refOf("gk-1"))).toBe(renderItem(gotcha, project));
    expect(cache.items["gk-1"]).toEqual({ ref: fake.refOf("gk-1"), text: renderItem(gotcha, project), updated: ts });
  });

  it("sends nothing when nothing changed since the last sync", async () => {
    const fake = fakeMemoryStore(project);
    const first = await sync(fake, ledger(gotcha, command));
    fake.calls.length = 0;
    const second = await sync(fake, ledger(gotcha, command), first.cache);
    expect(fake.calls).toEqual([]);
    expect(second.outcome.written).toEqual([]);
  });

  it("rewrites an item when its entry changed", async () => {
    const fake = fakeMemoryStore(project);
    const first = await sync(fake, ledger(gotcha));
    const changed = { ...gotcha, content: "Typecheck mod code with `npm run typecheck`", updated: later };
    const { outcome } = await sync(fake, ledger(changed), first.cache);
    expect(outcome.written).toEqual(["gk-1"]);
    expect(fake.items.get(fake.refOf("gk-1"))).toContain("Gotcha: Typecheck mod code with `npm run typecheck`");
  });

  it("removes the item of an entry the ledger retired", async () => {
    const fake = fakeMemoryStore(project);
    const first = await sync(fake, ledger(gotcha, command));
    const retired: Entry = { ...gotcha, status: "deprecated", updated: later };
    const { cache, outcome } = await sync(fake, ledger(retired, command), first.cache);
    expect(outcome.removed).toEqual(["gk-1"]);
    expect(fake.items.has(fake.refOf("gk-1"))).toBe(false);
    expect(cache.items["gk-1"]).toBeUndefined();
  });

  it("removes a retired entry's item that another copy wrote, once it checks memory", async () => {
    const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project) });
    const retired: Entry = { ...gotcha, status: "deprecated", updated: later };
    const { outcome } = await sync(fake, ledger(retired), emptyCache(), new Set(), true);
    expect(outcome.removed).toEqual(["gk-1"]);
    expect(fake.items.size).toBe(0);
  });

  it("neither writes nor removes an entry whose evidence is gone", async () => {
    const fake = fakeMemoryStore(project);
    const first = await sync(fake, ledger(gotcha));
    const changed = { ...gotcha, content: "Something new", updated: later };
    const fresh = entry({ id: "gk-2", type: "gotcha", title: "Another", content: "Another fact", created: ts, updated: ts });
    const { outcome } = await sync(fake, ledger(changed, fresh), first.cache, new Set(["gk-1", "gk-2"]), true);
    expect(outcome.written).toEqual([]);
    expect(outcome.removed).toEqual([]);
    expect(fake.items.get(fake.refOf("gk-1"))).toBe(renderItem(gotcha, project));
    expect(fake.items.has(fake.refOf("gk-2"))).toBe(false);
  });

  it("never overwrites a newer version that another copy wrote", async () => {
    const newer = renderItem({ ...gotcha, content: "Written by a copy that is ahead", updated: later }, project);
    const fake = fakeMemoryStore(project, { "gk-1": newer });
    const { cache, outcome } = await sync(fake, ledger(gotcha));
    expect(outcome.newer).toEqual(["gk-1"]);
    expect(fake.items.get(fake.refOf("gk-1"))).toBe(newer);
    expect(cache.items["gk-1"]).toBeUndefined();
  });

  it("takes over an identical item another copy wrote without writing it again", async () => {
    const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project) });
    const { cache, outcome } = await sync(fake, ledger(gotcha));
    expect(outcome.adopted).toEqual(["gk-1"]);
    expect(fake.calls).not.toContain("put gk-1");
    expect(cache.items["gk-1"]?.ref).toBe(fake.refOf("gk-1"));
  });

  it("takes over an identical item even when memory gives it back without the final newline", async () => {
    const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project).trimEnd() });
    const { outcome } = await sync(fake, ledger(gotcha));
    expect(outcome.adopted).toEqual(["gk-1"]);
    expect(fake.calls).not.toContain("put gk-1");
  });

  it("does not bring back an item that vanished from memory", async () => {
    const fake = fakeMemoryStore(project);
    const first = await sync(fake, ledger(gotcha));
    fake.items.clear();
    const { outcome } = await sync(fake, ledger(gotcha), first.cache, new Set(), true);
    expect(outcome.missing).toEqual(["gk-1"]);
    expect(fake.items.size).toBe(0);
  });

  it("reports items its ledger does not know and leaves them", async () => {
    const theirs = renderItem(entry({ id: "gk-x", type: "gotcha", title: "From another branch", content: "Only there", created: ts, updated: ts }), project);
    const fake = fakeMemoryStore(project, { "gk-x": theirs });
    const { outcome } = await sync(fake, ledger(gotcha), emptyCache(), new Set(), true);
    expect(outcome.unknown).toEqual(["gk-x"]);
    expect(fake.items.get(fake.refOf("gk-x"))).toBe(theirs);
  });

  it("keeps syncing the rest when one item fails, and retries it next time", async () => {
    const fake = fakeMemoryStore(project);
    fake.failPut.add("gk-1");
    const first = await sync(fake, ledger(gotcha, command));
    expect(first.outcome.failed).toEqual([{ id: "gk-1", error: "server down" }]);
    expect(first.outcome.written).toEqual(["cmd-1"]);
    fake.failPut.clear();
    const second = await sync(fake, ledger(gotcha, command), first.cache);
    expect(second.outcome.written).toEqual(["gk-1"]);
  });
});

describe("syncMemory", () => {
  const withLedger = async (...entries: Entry[]) => {
    const io = memoryIo();
    await appendLedger(
      io,
      entries.map((e) => ({ v: 1, ts, op: "add", entry: e })),
    );
    return io;
  };

  it("syncs from the ledger file, then skips while the ledger stays the same", async () => {
    const io = await withLedger(gotcha);
    const fake = fakeMemoryStore(project);
    const first = await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
    expect(first?.written).toEqual(["gk-1"]);
    fake.calls.length = 0;
    expect(await syncMemory({ io, store: fake.store, project, mode: "fast", now: later })).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("tries a failed item again on the next sync even if the ledger did not change", async () => {
    const io = await withLedger(gotcha);
    const fake = fakeMemoryStore(project);
    fake.failPut.add("gk-1");
    await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
    fake.failPut.clear();
    expect((await syncMemory({ io, store: fake.store, project, mode: "fast", now: later }))?.written).toEqual(["gk-1"]);
  });

  it("checks memory when this copy has sent nothing yet", async () => {
    const io = await withLedger(gotcha);
    const theirs = renderItem(entry({ id: "gk-x", type: "gotcha", title: "From another clone", content: "Only there", created: ts, updated: ts }), project);
    const fake = fakeMemoryStore(project, { "gk-x": theirs });
    const outcome = await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
    expect(outcome?.unknown).toEqual(["gk-x"]);
  });

  it("knows memory is up to date until the ledger changes or a sync failed", async () => {
    const io = await withLedger(gotcha);
    const fake = fakeMemoryStore(project);
    expect(await memoryUpToDate(io)).toBe(false);
    await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
    expect(await memoryUpToDate(io)).toBe(true);
    await appendLedger(io, [{ v: 1, ts: later, op: "add", entry: command }]);
    expect(await memoryUpToDate(io)).toBe(false);
    fake.failPut.add("cmd-1");
    await syncMemory({ io, store: fake.store, project, mode: "fast", now: later });
    expect(await memoryUpToDate(io)).toBe(false);
  });

  it("clears this project's Archivist items, leaves what a person put there, and forgets what it sent", async () => {
    const io = await withLedger(gotcha);
    const fake = fakeMemoryStore(project);
    await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
    fake.items.set(fake.refOf("notes"), "# My own notes\n");
    expect(await clearMemory(io, fake.store, project)).toEqual(["gk-1"]);
    expect([...fake.items.keys()]).toEqual([fake.refOf("notes")]);
    expect((await loadMemoryCache(io, "fake", project)).items).toEqual({});
  });

  it("starts a fresh cache when the project is no longer the one it was written for", async () => {
    const io = await withLedger(gotcha);
    const fake = fakeMemoryStore(project);
    await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
    expect((await loadMemoryCache(io, "fake", project)).items["gk-1"]).toBeDefined();
    expect((await loadMemoryCache(io, "fake", "github.com/someone/else")).items).toEqual({});
  });
});
