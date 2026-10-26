import { DEFAULT_CONFIG, type Config } from "../src/core/config.js";
import type { Io } from "../src/core/io.js";
import type { MemoryStore } from "../src/core/memory.js";
import type { Entry, Segment, ToolEvent } from "../src/core/types.js";

/** In-memory Io. Directories are implied by files; `dirs` adds empty ones (left behind by an earlier version). */
export const memoryIo = (files: Record<string, string> = {}, dirs: string[] = []): Io & { files: Map<string, string>; dirs: Set<string> } => {
  const map = new Map(Object.entries(files));
  const empty = new Set(dirs);
  const under = (dir: string) => [...map.keys(), ...empty].filter((k) => k.startsWith(`${dir}/`));
  return {
    root: "/proj",
    files: map,
    dirs: empty,
    async read(p) {
      return map.get(p);
    },
    async write(p, t) {
      map.set(p, t);
    },
    async exists(p) {
      return map.has(p) || empty.has(p) || under(p).length > 0;
    },
    async list(dir) {
      return [...new Set(under(dir).map((k) => k.slice(dir.length + 1).split("/")[0]!))];
    },
    async remove(p) {
      map.delete(p);
    },
    async removeEmptyDir(p) {
      if (!under(p).length) empty.delete(p);
    },
  };
};

export const config = (over: Partial<Config["apply"]> = {}): Config => ({ ...DEFAULT_CONFIG, apply: { ...DEFAULT_CONFIG.apply, ...over } });

export const entry = (over: Partial<Entry> & Pick<Entry, "id" | "type" | "title" | "content">): Entry => ({
  evidence: [],
  status: "active",
  confidence: 0.9,
  source: "analyzer",
  created: "2026-10-01T00:00:00.000Z",
  updated: "2026-10-01T00:00:00.000Z",
  reinforced: 0,
  ...over,
});

export const fakeMemoryStore = (project: string, seed: Record<string, string> = {}) => {
  const prefix = `fake://${project}/`;
  const refOf = (id: string) => `${prefix}${id}.md`;
  const items = new Map(Object.entries(seed).map(([id, text]) => [refOf(id), text]));
  const calls: string[] = [];
  const failPut = new Set<string>();
  const store: MemoryStore = {
    name: "fake",
    async put(id, text) {
      calls.push(`put ${id}`);
      if (failPut.has(id)) throw new Error("server down");
      items.set(refOf(id), text);
      return refOf(id);
    },
    async remove(ref) {
      calls.push(`remove ${ref}`);
      items.delete(ref);
    },
    async fetch(id) {
      calls.push(`fetch ${id}`);
      const text = items.get(refOf(id));
      return text === undefined ? undefined : { ref: refOf(id), text };
    },
    async list() {
      calls.push("list");
      return [...items.keys()].filter((ref) => ref.startsWith(prefix)).map((ref) => ({ ref, id: ref.slice(prefix.length, -".md".length) }));
    },
  };
  return { store, items, calls, failPut, refOf };
};

export const segment = (tools: ToolEvent[], prompts = ["fix the export"]): Segment => ({
  id: "seg1",
  session: "sess-1234567890",
  startedAt: 0,
  prompts,
  answers: ["done"],
  turns: [{ turnId: "t1", durationMs: 60_000, usage: { input: 10, output: 2000, cacheRead: 500_000, cacheWrite: 3000 } }],
  tools,
  rulesLoaded: [],
});
