import type { MemoryStore } from "./memory.js";

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

const textOrThrow = (reply: McpReply): string => {
  if (reply.isError) throw new Error(reply.text.trim());
  return reply.text;
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
      const reply = await call("read", { uris: uriOf(id) });
      if (isNotFound(reply.text)) return undefined;
      return { ref: uriOf(id), text: textOrThrow(reply) };
    },
    async list() {
      const reply = await call("list", { uri: folder });
      if (isNotFound(reply.text)) return [];
      return textOrThrow(reply)
        .split("\n")
        .map((line) => line.match(/^\[file\] ([^./][^/]*)\.md$/)?.[1])
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id, ref: uriOf(id) }));
    },
  };
};
