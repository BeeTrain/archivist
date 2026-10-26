import { describe, expect, it } from "vitest";
import { reconcile } from "../src/core/memory.js";
import { findOpenVikingServer, openVikingStore, type McpReply } from "../src/core/memory-openviking.js";
import { entry } from "./helpers.js";

const project = "github.com/beetrain/archivist";
const base = "viking://resources/archivist/github.com/beetrain/archivist/";

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
    expect(await store.put("gk-1", "# Title\n")).toBe(`${base}gk-1.md`);
    expect(calls).toEqual([{ tool: "write", args: { uri: `${base}gk-1.md`, content: "# Title\n", mode: "replace" } }]);
  });

  it("fails a write the server refused", async () => {
    const { store } = server({ write: { isError: true, text: "Error executing tool write: permission denied" } });
    await expect(store.put("gk-1", "# Title\n")).rejects.toThrow("permission denied");
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
    expect(await store.list!()).toEqual([
      { id: "gk-1", ref: `${base}gk-1.md` },
      { id: "cmd-2", ref: `${base}cmd-2.md` },
    ]);
    expect(calls[0]).toEqual({ tool: "list", args: { uri: base } });
    expect(await server({ list: { isError: false, text: listing } }).store.list!()).toHaveLength(2);
  });

  it("lists nothing for a project with no folder yet", async () => {
    expect(await server({ list: { isError: false, text: JSON.stringify({ result: `(no entries under ${base})` }) } }).store.list!()).toEqual([]);
    expect(await server({ list: { isError: true, text: `Error executing tool list: Directory not found: ${base}` } }).store.list!()).toEqual([]);
  });
});
