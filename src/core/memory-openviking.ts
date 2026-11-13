import { MEMORY_SEARCH_WIDTH, type MemoryHit, type MemoryStore } from "./memory.js";

export interface McpReply {
  text: string;
  isError: boolean;
}

export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<McpReply>;

const NEEDED_TOOLS = ["write", "forget", "read", "list"];

export const findOpenVikingServer = (tools: { name: string; serverName: string }[]): string | undefined => {
  const toolsByServer = new Map<string, Set<string>>();
  for (const tool of tools) toolsByServer.set(tool.serverName, (toolsByServer.get(tool.serverName) ?? new Set()).add(tool.name.split("__").at(-1) ?? ""));
  for (const [server, names] of toolsByServer) if (/openviking/i.test(server) && NEEDED_TOOLS.every((name) => names.has(name))) return server;
  return undefined;
};

const isNotFound = (text: string): boolean => /not found: viking:\/\//i.test(text) && !text.trim().includes("\n");

const unwrapped = (text: string): string => {
  try {
    const value = JSON.parse(text) as { result?: unknown } | null;
    return typeof value?.result === "string" ? value.result : text;
  } catch {
    return text;
  }
};

const textOrThrow = (reply: McpReply): string => {
  if (reply.isError) throw new Error(reply.text.trim());
  return unwrapped(reply.text);
};

const HIT_HEADER = /^- \[\w+ (\d+)%\] (viking:\/\/\S+)$/;
const FILES_ONLY = [2];
const READ_MORE = "Use the read tool to expand a URI.";
const NO_ABSTRACT = "(no abstract)";
const ARCHIVIST_FOLDER = "viking://resources/archivist/";
const ARCHIVIST_ITEM = /^viking:\/\/resources\/archivist\/(.+)\/([^./][^/]*)\.md$/;

const hitsIn = (answer: string): MemoryHit[] => {
  const found: { ref: string; percent: number; lines: string[] }[] = [];
  for (const line of answer.split("\n")) {
    const header = line.match(HIT_HEADER);
    if (header) found.push({ ref: header[2]!, percent: Number(header[1]), lines: [] });
    else if (line.trim() !== READ_MORE) found.at(-1)?.lines.push(line.trim());
  }
  const best = [...found].sort((a, b) => b.percent - a.percent);
  return best.flatMap(({ ref, lines }) => {
    const text = lines.join("\n").trim();
    const item = ref.match(ARCHIVIST_ITEM);
    if (!text || text === NO_ABSTRACT || (ref.startsWith(ARCHIVIST_FOLDER) && !item)) return [];
    return [{ ref, text, ...(item ? { archivist: { project: item[1]!, id: item[2]! } } : {}) }];
  });
};

export const openVikingStore = (call: McpCall, project: string): MemoryStore => {
  const folder = `viking://resources/archivist/${project}/`;
  const uriOf = (id: string) => `${folder}${id}.md`;
  return {
    name: "openviking",
    async put(id, text) {
      textOrThrow(await call("write", { uri: uriOf(id), content: text, mode: "replace" }));
      return uriOf(id);
    },
    async remove(ref) {
      const reply = await call("forget", { uri: ref });
      if (reply.isError && !isNotFound(reply.text)) throw new Error(reply.text.trim());
    },
    async fetch(id) {
      const reply = await call("read", { uris: [uriOf(id)] });
      const text = unwrapped(reply.text);
      if (isNotFound(text)) return undefined;
      if (reply.isError) throw new Error(text.trim());
      return { ref: uriOf(id), text };
    },
    async list() {
      const reply = await call("list", { uri: folder });
      if (isNotFound(reply.text)) return { items: [] };
      const items = textOrThrow(reply)
        .split("\n")
        .map((line) => line.match(/^\[file\] ([^./][^/]*)\.md$/)?.[1])
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id, ref: uriOf(id) }));
      return { items };
    },
    async search(query, reach) {
      const where = reach === "shared" ? { target_uri: "viking://resources/" } : {};
      return hitsIn(textOrThrow(await call("find", { query, limit: MEMORY_SEARCH_WIDTH, level: FILES_ONLY, ...where })));
    },
  };
};
