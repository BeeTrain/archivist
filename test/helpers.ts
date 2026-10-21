import { DEFAULT_CONFIG, type Config } from "../src/core/config.js";
import type { Io } from "../src/core/io.js";
import type { Entry, Segment, ToolEvent } from "../src/core/types.js";

export const memoryIo = (files: Record<string, string> = {}): Io & { files: Map<string, string> } => {
  const map = new Map(Object.entries(files));
  return {
    root: "/proj",
    files: map,
    async read(p) {
      return map.get(p);
    },
    async write(p, t) {
      map.set(p, t);
    },
    async exists(p) {
      return map.has(p) || [...map.keys()].some((k) => k.startsWith(`${p}/`));
    },
    async list(dir) {
      return [...new Set([...map.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]!))];
    },
    async remove(p) {
      map.delete(p);
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
