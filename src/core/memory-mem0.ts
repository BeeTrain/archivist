import type { Mem0Scope } from "./mem0-scope.js";
import { MEMORY_SEARCH_WIDTH, MemoryRefused, MemoryRejected, readSignature, type MemoryHit, type MemoryItem, type MemoryListing, type MemoryStore, type Signature } from "./memory.js";

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
  if (reply.status >= 400 && reply.status < 500) throw new MemoryRejected(`mem0 rejected the request (HTTP ${reply.status}): ${reasonIn(reply.text)}`);
  throw new Error(`mem0 request failed (HTTP ${reply.status}): ${reasonIn(reply.text)}`);
};

const answerOf = <T>(reply: HttpReply): T | undefined => {
  const text = succeeded(reply).text;
  try {
    return (JSON.parse(text || "null") as T | null) ?? undefined;
  } catch {
    throw new MemoryRejected(`mem0 answered with something that is not JSON (HTTP ${reply.status}): ${reasonIn(text)}`);
  }
};

interface Mem0Memory {
  id?: string;
  memory?: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  score?: number;
}

const rowsOf = (answer: Mem0Memory[] | { results?: Mem0Memory[] } | undefined): Mem0Memory[] => (Array.isArray(answer) ? answer : (answer?.results ?? []));

const itemsOf = (memories: Mem0Memory[]): MemoryItem[] =>
  memories.flatMap((m) => {
    const id = m.metadata?.archivist_id;
    return m.id && typeof id === "string" ? [{ ref: m.id, id, ...(typeof m.memory === "string" ? { text: m.memory } : {}) }] : [];
  });

const hitsOf = (memories: Mem0Memory[]): MemoryHit[] =>
  memories.flatMap((m) => {
    if (!m.id || typeof m.memory !== "string") return [];
    const project = m.metadata?.archivist_project;
    const id = m.metadata?.archivist_id;
    const archivist = typeof project === "string" && typeof id === "string" ? { archivist: { project, id } } : {};
    const changed = m.updated_at ?? m.created_at;
    return [{ ref: m.id, text: m.memory, ...(changed ? { changed } : {}), ...archivist }];
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

const addedId = (reply: HttpReply): string => {
  const added = answerOf<{ results?: { id?: string }[] }>(reply)?.results?.[0]?.id;
  if (!added) throw new MemoryRejected("mem0 stored nothing");
  return added;
};

const removeAt = async (http: HttpCall, path: string): Promise<void> => {
  const reply = await http("DELETE", path);
  if (reply.status !== 404) succeeded(reply);
};

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
  const remove = (ref: string): Promise<void> => removeAt(http, `/v1/memories/${encodeURIComponent(ref)}/`);
  return {
    name: "mem0",
    readsCostQuota: true,
    listsText: true,
    async put(_id, text, ref, signature) {
      const added = addedId(
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
    async search(query, reach) {
      const projectChannel = { AND: [{ agent_id: scope.agentId }, { app_id: scope.appId }] };
      const personalChannel = { AND: [{ user_id: scope.userId }, { app_id: scope.appId }] };
      const filters = reach === "shared" ? projectChannel : { OR: [projectChannel, personalChannel] };
      return hitsOf(rowsOf(answerOf<{ results?: Mem0Memory[] }>(await http("POST", "/v3/memories/search/", { query, filters, top_k: MEMORY_SEARCH_WIDTH }))));
    },
  };
};

const SERVER_LIST_LIMIT = 1000;

export const mem0ServerStore = (http: HttpCall, scope: Mem0Scope, project: string, name: string): MemoryStore => {
  const add = async (text: string, signature: Signature): Promise<string> =>
    addedId(await http("POST", "/memories", { messages: [{ role: "user", content: text }], infer: false, agent_id: scope.agentId, user_id: scope.userId, metadata: metadataOf(signature) }));
  const listNow = async (): Promise<MemoryListing> => {
    const answer = answerOf<Mem0Memory[] | { results?: Mem0Memory[] }>(await http("GET", `/memories?agent_id=${encodeURIComponent(scope.agentId)}&top_k=${SERVER_LIST_LIMIT}`));
    const rows = rowsOf(answer);
    return { items: itemsOf(rows.filter((row) => row.metadata?.archivist_project === project)), cut: rows.length >= SERVER_LIST_LIMIT };
  };
  let lastListing: Promise<MemoryListing> | undefined;
  const list = (): Promise<MemoryListing> => (lastListing = listNow());
  const searchChannel = async (query: string, filters: Record<string, string>): Promise<Mem0Memory[]> =>
    rowsOf(answerOf<Mem0Memory[] | { results?: Mem0Memory[] }>(await http("POST", "/search", { query, filters, top_k: MEMORY_SEARCH_WIDTH })));
  return {
    name,
    readsCostQuota: false,
    listsText: true,
    async put(_id, text, ref, signature) {
      if (!ref) return add(text, signature);
      const reply = await http("PUT", `/memories/${encodeURIComponent(ref)}`, { text, metadata: metadataOf(signature) });
      if (reply.status === 404) return add(text, signature);
      succeeded(reply);
      return ref;
    },
    remove: (ref) => removeAt(http, `/memories/${encodeURIComponent(ref)}`),
    async fetch(id, ref) {
      if (ref) {
        const reply = await http("GET", `/memories/${encodeURIComponent(ref)}`);
        const found = reply.status === 404 ? undefined : answerOf<Mem0Memory>(reply);
        if (found?.metadata?.archivist_key === `archivist/${project}/${id}` && typeof found.memory === "string") return { ref: found.id ?? ref, text: found.memory };
      }
      return newestOf((await (lastListing ?? list())).items.filter((item) => item.id === id));
    },
    list,
    async search(query, reach) {
      if (reach === "shared") return hitsOf(await searchChannel(query, { agent_id: scope.agentId }));
      const channels = await Promise.all([searchChannel(query, { agent_id: scope.agentId }), searchChannel(query, { user_id: scope.userId })]);
      const once = new Map(channels.flat().map((row) => [row.id, row]));
      return hitsOf([...once.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)));
    },
  };
};
