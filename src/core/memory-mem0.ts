import type { Mem0Scope } from "./mem0-scope.js";
import { MemoryRefused, readSignature, type MemoryItem, type MemoryStore, type Signature } from "./memory.js";

export interface HttpReply {
  status: number;
  text: string;
}

export type HttpCall = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<HttpReply>;

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpReply>;

export interface Mem0Auth {
  header: string;
  value: string;
  secret: string;
}

export const MEM0_CLOUD_URL = "https://api.mem0.ai";

export const isMem0Cloud = (address: string): boolean => {
  if (!address.trim()) return true;
  try {
    const host = new URL(address.trim()).hostname;
    return host === "mem0.ai" || host.endsWith(".mem0.ai");
  } catch {
    return false;
  }
};

const hostAndPath = (address: string): string => {
  try {
    const url = new URL(address);
    return `${url.host}${url.pathname}`;
  } catch {
    return address;
  }
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const mem0StoreName = (address: string): string => (isMem0Cloud(address) ? "mem0" : `mem0-${slug(hostAndPath(address.trim()))}`);

export const mem0Transport = (fetcher: Fetcher, base: string, auth: Mem0Auth | undefined): HttpCall => {
  const root = base.trim().replace(/\/+$/, "");
  const masked = (text: string): string => (auth?.secret ? text.replaceAll(auth.secret, "***") : text);
  return async (method, path, body) => {
    const headers = { "Content-Type": "application/json", ...(auth ? { [auth.header]: auth.value } : {}) };
    try {
      const reply = await fetcher(`${root}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: reply.status, text: masked(reply.text) };
    } catch (err) {
      throw new Error(`mem0 at ${root} is unreachable: ${masked(err instanceof Error ? err.message : String(err))}`);
    }
  };
};

const REFUSED_STATUSES = new Set([401, 402, 403, 429]);

const saidIn = (text: string): string => {
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown } | null;
    const said = body?.detail ?? body?.message ?? body?.error;
    return said === undefined ? text : typeof said === "string" ? said : JSON.stringify(said);
  } catch {
    return text;
  }
};

const reasonIn = (text: string): string => saidIn(text).replace(/\s+/g, " ").trim().slice(0, 200);

const succeeded = (reply: HttpReply): HttpReply => {
  if (reply.status >= 200 && reply.status < 300) return reply;
  if (REFUSED_STATUSES.has(reply.status)) throw new MemoryRefused(`mem0 refused the request (HTTP ${reply.status}): ${reasonIn(reply.text)}`);
  throw new Error(`mem0 request failed (HTTP ${reply.status}): ${reasonIn(reply.text)}`);
};

const answerOf = <T>(reply: HttpReply): T | undefined => {
  const text = succeeded(reply).text;
  try {
    return (JSON.parse(text || "null") as T | null) ?? undefined;
  } catch {
    throw new Error(`mem0 answered with something that is not JSON (HTTP ${reply.status}): ${reasonIn(text)}`);
  }
};

interface Mem0Memory {
  id?: string;
  memory?: string;
  metadata?: Record<string, unknown> | null;
}

const itemsOf = (memories: Mem0Memory[]): MemoryItem[] =>
  memories.flatMap((m) => {
    const id = m.metadata?.archivist_id;
    return m.id && typeof id === "string" ? [{ ref: m.id, id, ...(typeof m.memory === "string" ? { text: m.memory } : {}) }] : [];
  });

const newestOf = (copies: MemoryItem[]): { ref: string; text: string } | undefined => {
  const updated = (c: MemoryItem) => (c.text === undefined ? "" : (readSignature(c.text)?.updated ?? ""));
  const newest = copies.filter((c) => c.text !== undefined).reduce<MemoryItem | undefined>((a, b) => (!a || updated(b) > updated(a) ? b : a), undefined);
  return newest ? { ref: newest.ref, text: newest.text! } : undefined;
};

const metadataOf = (signature: Signature) => ({
  archivist_key: `archivist/${signature.project}/${signature.id}`,
  archivist_project: signature.project,
  archivist_id: signature.id,
  archivist_updated: signature.updated,
});

const LIST_FIELDS = ["id", "memory", "metadata", "updated_at"];

export const mem0CloudStore = (http: HttpCall, scope: Mem0Scope, project: string): MemoryStore => {
  const listWhere = async (metadata: Record<string, string>): Promise<MemoryItem[]> => {
    const items: MemoryItem[] = [];
    for (let page = 1; ; page++) {
      const answer = answerOf<{ next?: string | null; results?: Mem0Memory[] }>(
        await http("POST", `/v3/memories/?page=${page}&page_size=200`, { filters: { AND: [{ app_id: scope.appId }, { metadata }] }, fields: LIST_FIELDS }),
      );
      const results = answer?.results ?? [];
      items.push(...itemsOf(results));
      if (!answer?.next || !results.length) return items;
    }
  };
  const remove = async (ref: string): Promise<void> => {
    const reply = await http("DELETE", `/v1/memories/${encodeURIComponent(ref)}/`);
    if (reply.status !== 404) succeeded(reply);
  };
  return {
    name: "mem0",
    readsCostQuota: true,
    listsText: true,
    async put(_id, text, ref, signature) {
      const answer = answerOf<{ results?: { id?: string }[] }>(
        await http("POST", "/v3/memories/add/", {
          messages: [{ role: "user", content: text }],
          infer: false,
          immutable: true,
          app_id: scope.appId,
          agent_id: scope.agentId,
          user_id: scope.userId,
          metadata: metadataOf(signature),
        }),
      );
      const added = answer?.results?.[0]?.id;
      if (!added) throw new Error("mem0 stored nothing");
      if (ref && ref !== added) {
        try {
          await remove(ref);
        } catch (err) {
          if (err instanceof MemoryRefused) throw err;
        }
      }
      return added;
    },
    remove,
    fetch: async (id) => newestOf(await listWhere({ archivist_key: `archivist/${project}/${id}` })),
    list: async () => ({ items: await listWhere({ archivist_project: project }) }),
  };
};
