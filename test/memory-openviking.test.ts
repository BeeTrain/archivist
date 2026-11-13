import { describe, expect, it } from "vitest";
import { MEMORY_SEARCH_WIDTH, reconcile } from "../src/core/memory.js";
import { findOpenVikingServer, openVikingStore, type McpReply } from "../src/core/memory-openviking.js";
import { entry } from "./helpers.js";

const project = "github.com/beetrain/archivist";
const base = "viking://resources/archivist/github.com/beetrain/archivist/";
const signature = { project, id: "gk-1", updated: "2026-10-23T10:00:00.000Z" };

const server = (replies: Record<string, McpReply>) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call = async (tool: string, args: Record<string, unknown>): Promise<McpReply> => {
    calls.push({ tool, args });
    const reply = replies[tool];
    if (!reply) throw new Error(`unexpected ${tool}`);
    return reply;
  };
  return { calls, store: openVikingStore(call, project) };
};

describe("finding the OpenViking server", () => {
  const tool = (serverName: string, op: string) => ({ name: `mcp__${serverName.replace(/[:]/g, "_")}__${op}`, serverName });

  it("picks the server that offers the file tools Archivist needs", () => {
    const tools = [
      tool("plugin:engineering:github", "write"),
      ...["write", "forget", "read", "list", "find"].map((op) => tool("plugin:openviking-memory:openviking", op)),
    ];
    expect(findOpenVikingServer(tools)).toBe("plugin:openviking-memory:openviking");
  });

  it("finds none when an OpenViking server lacks a tool it needs", () => {
    expect(findOpenVikingServer(["read", "list", "find"].map((op) => tool("plugin:openviking-memory:openviking", op)))).toBeUndefined();
  });
});

describe("the OpenViking store", () => {
  it("writes an item as a resource file of the project and answers with its address", async () => {
    const { calls, store } = server({ write: { isError: false, text: JSON.stringify({ result: `Wrote 12 bytes to ${base}gk-1.md (mode=create).\nIndexing: semantic=queued, vector=queued.` }) } });
    expect(await store.put("gk-1", "# Title\n", undefined, signature)).toBe(`${base}gk-1.md`);
    expect(calls).toEqual([{ tool: "write", args: { uri: `${base}gk-1.md`, content: "# Title\n", mode: "replace" } }]);
  });

  it("fails a write the server refused", async () => {
    const { store } = server({ write: { isError: true, text: "Error executing tool write: permission denied" } });
    await expect(store.put("gk-1", "# Title\n", undefined, signature)).rejects.toThrow("permission denied");
  });

  it("counts removing an item that is already gone as done, and fails on other errors", async () => {
    const gone = server({ forget: { isError: false, text: JSON.stringify({ result: `Deleted: ${base}gk-1.md` }) } });
    await expect(gone.store.remove(`${base}gk-1.md`)).resolves.toBeUndefined();
    expect(gone.calls[0]).toEqual({ tool: "forget", args: { uri: `${base}gk-1.md` } });
    const broken = server({ forget: { isError: true, text: "Error executing tool forget: storage offline" } });
    await expect(broken.store.remove(`${base}gk-1.md`)).rejects.toThrow("storage offline");
  });

  it("reads an item back, and takes the server's not-found answer for no item", async () => {
    const present = server({ read: { isError: false, text: "# Title\n\nProject: x · Archivist gk-1 · updated 2026-10-23T10:00:00.000Z\n" } });
    expect(await present.store.fetch!("gk-1")).toEqual({ ref: `${base}gk-1.md`, text: "# Title\n\nProject: x · Archivist gk-1 · updated 2026-10-23T10:00:00.000Z\n" });
    expect(present.calls[0]).toEqual({ tool: "read", args: { uris: [`${base}gk-1.md`] } });
    const absent = server({ read: { isError: false, text: `File not found: ${base}gk-1.md` } });
    expect(await absent.store.fetch!("gk-1")).toBeUndefined();
  });

  it("reads an item from the answer wrapped as the server sends it", async () => {
    const item = "# Title\n\nGotcha: one\n\nProject: x · Archivist gk-1 · updated 2026-10-23T10:00:00.000Z\n";
    const present = server({ read: { isError: false, text: JSON.stringify({ result: item }) } });
    expect(await present.store.fetch!("gk-1")).toEqual({ ref: `${base}gk-1.md`, text: item });
    const absent = server({ read: { isError: false, text: JSON.stringify({ result: `File not found: ${base}gk-1.md` }) } });
    expect(await absent.store.fetch!("gk-1")).toBeUndefined();
  });

  it("never overwrites a newer item it read from a wrapped answer", async () => {
    const newer = `# Title\n\nGotcha: changed by another clone\n\nProject: ${project} · Archivist gk-1 · updated 2026-10-24T00:00:00.000Z\n`;
    const { calls, store } = server({ read: { isError: false, text: JSON.stringify({ result: newer }) } });
    const entries = new Map([["gk-1", entry({ id: "gk-1", type: "gotcha", title: "Title", content: "one", updated: "2026-10-23T10:00:00.000Z" })]]);
    const { outcome } = await reconcile({ store, entries, stale: new Set(), cache: { store: "openviking", project, items: {} }, verify: false });
    expect(outcome.newer).toEqual(["gk-1"]);
    expect(calls.map((c) => c.tool)).toEqual(["read"]);
  });

  it("lists the project's item files and nothing else, from the answer wrapped as the server sends it", async () => {
    const listing = "[file] gk-1.md\n[file] cmd-2.md\n[dir] drafts\n[file] .abstract.md\n[file] notes.txt";
    const { calls, store } = server({ list: { isError: false, text: JSON.stringify({ result: listing }) } });
    expect(await store.list!()).toEqual({
      items: [
        { id: "gk-1", ref: `${base}gk-1.md` },
        { id: "cmd-2", ref: `${base}cmd-2.md` },
      ],
    });
    expect(calls[0]).toEqual({ tool: "list", args: { uri: base } });
    expect((await server({ list: { isError: false, text: listing } }).store.list!()).items).toHaveLength(2);
  });

  it("lists nothing for a project with no folder yet", async () => {
    expect(await server({ list: { isError: false, text: JSON.stringify({ result: `(no entries under ${base})` }) } }).store.list!()).toEqual({ items: [] });
    expect(await server({ list: { isError: true, text: `Error executing tool list: Directory not found: ${base}` } }).store.list!()).toEqual({ items: [] });
  });
});

describe("searching OpenViking", () => {
  const answer = (...lines: string[]): McpReply => ({ isError: false, text: JSON.stringify({ result: lines.join("\n") }) });

  it("searches the shared resources only, wider than what it will show", async () => {
    const { calls, store } = server({ find: answer("No matching context found.") });
    expect(await store.search!("how to release", "shared")).toEqual([]);
    expect(calls).toEqual([{ tool: "find", args: { query: "how to release", limit: MEMORY_SEARCH_WIDTH, level: [2], target_uri: "viking://resources/" } }]);
  });

  it("searches everything the user keeps when asked for all of it", async () => {
    const { calls, store } = server({ find: { isError: false, text: "No matching context found." } });
    expect(await store.search!("how to release", "all")).toEqual([]);
    expect(calls).toEqual([{ tool: "find", args: { query: "how to release", limit: MEMORY_SEARCH_WIDTH, level: [2] } }]);
  });

  it("reads each hit with the whole of its abstract, which the server indents only on the first line", async () => {
    const { store } = server({
      find: answer(
        "Found 2 item(s):",
        "",
        "- [resource 87%] viking://resources/notes/release.md",
        "    Release from main only.",
        "Tag after the build.",
        "- [memory 41%] viking://user/u1/memories/style.md",
        "    Prefers short notes",
        "",
        "Use the read tool to expand a URI.",
      ),
    });
    expect(await store.search!("release", "all")).toEqual([
      { ref: "viking://resources/notes/release.md", text: "Release from main only.\nTag after the build." },
      { ref: "viking://user/u1/memories/style.md", text: "Prefers short notes" },
    ]);
  });

  it("ranks hits by score: the server lists them by kind", async () => {
    const { store } = server({
      find: answer("Found 3 item(s):", "", "- [memory 36%] viking://user/u1/memories/a.md", "    Weak", "- [memory 41%] viking://user/u1/memories/b.md", "    Fair", "- [resource 95%] viking://resources/notes/c.md", "    Strong"),
    });
    expect((await store.search!("x", "all")).map((hit) => hit.text)).toEqual(["Strong", "Fair", "Weak"]);
  });

  it("knows an Archivist item of any project by its address", async () => {
    const { store } = server({
      find: answer("Found 2 item(s):", "", `- [resource 90%] ${base}gk-1.md`, "    One", "- [resource 80%] viking://resources/archivist/local/tools/cmd-2.md", "    Two"),
    });
    expect(await store.search!("x", "shared")).toEqual([
      { ref: `${base}gk-1.md`, text: "One", archivist: { project, id: "gk-1" } },
      { ref: "viking://resources/archivist/local/tools/cmd-2.md", text: "Two", archivist: { project: "local/tools", id: "cmd-2" } },
    ]);
  });

  it("leaves out what has no text yet and what only sums up Archivist's own folders", async () => {
    const { store } = server({
      find: answer(
        "Found 4 item(s):",
        "",
        "- [resource 90%] viking://resources/notes/fresh.md",
        "    (no abstract)",
        `- [resource 80%] ${base}`,
        "    All the gotchas of this project",
        `- [resource 70%] ${base}.overview.md`,
        "    All the gotchas again",
        "- [resource 60%] viking://resources/notes/kept.md",
        "    Kept",
      ),
    });
    expect(await store.search!("x", "shared")).toEqual([{ ref: "viking://resources/notes/kept.md", text: "Kept" }]);
  });

  it("fails a search the server refused", async () => {
    const { store } = server({ find: { isError: true, text: "Error executing tool find: embedder offline" } });
    await expect(store.search!("x", "shared")).rejects.toThrow("embedder offline");
  });
});
