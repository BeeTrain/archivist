import { describe, expect, it } from "vitest";
import type { Mem0Scope } from "../src/core/mem0-scope.js";
import { MEMORY_SEARCH_WIDTH, MemoryRefused, MemoryRejected } from "../src/core/memory.js";
import { isMem0Cloud, MEM0_CLOUD_URL, mem0CloudStore, mem0ServerStore, mem0StoreName, mem0Transport, type Fetcher, type HttpCall, type HttpReply } from "../src/core/memory-mem0.js";

const project = "github.com/beetrain/archivist";
const scope: Mem0Scope = { appId: "BeeTrain-archivist", agentId: "BeeTrain-archivist-0123456789", userId: "dev-user" };
const signature = { project, id: "gk-1", updated: "2026-10-23T10:00:00.000Z" };
const metadata = { archivist_key: `archivist/${project}/gk-1`, archivist_project: project, archivist_id: "gk-1", archivist_updated: "2026-10-23T10:00:00.000Z" };
const json = (status: number, body: unknown): HttpReply => ({ status, text: JSON.stringify(body) });
const fakeHttp = (replies: HttpReply[]) => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const http: HttpCall = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected ${method} ${path}`);
    return reply;
  };
  return { calls, http };
};

describe("talking to mem0", () => {
  const recording = (reply: HttpReply = { status: 200, text: "{}" }) => {
    const seen: { url: string; init: Parameters<Fetcher>[1] }[] = [];
    const fetcher: Fetcher = async (url, init) => (seen.push({ url, init }), reply);
    return { seen, fetcher };
  };

  it("joins the address and the path without a double slash and sends JSON with the auth header", async () => {
    const { seen, fetcher } = recording();
    await mem0Transport(fetcher, "http://localhost:8888/", { header: "X-API-Key", value: "k-123", secret: "k-123" })("POST", "/memories", { a: 1 });
    expect(seen[0]).toEqual({ url: "http://localhost:8888/memories", init: { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "k-123" }, body: '{"a":1}' } });
  });

  it("sends no auth header without a key", async () => {
    const { seen, fetcher } = recording();
    await mem0Transport(fetcher, "http://localhost:8888", undefined)("GET", "/memories");
    expect(seen[0]?.init).toEqual({ method: "GET", headers: { "Content-Type": "application/json" } });
  });

  it("masks the key when the server repeats it", async () => {
    const { fetcher } = recording({ status: 401, text: '{"detail":"bad key k-123"}' });
    const reply = await mem0Transport(fetcher, MEM0_CLOUD_URL, { header: "Authorization", value: "Token k-123", secret: "k-123" })("GET", "/v1/ping/");
    expect(reply.text).toBe('{"detail":"bad key ***"}');
  });

  it("names the address when the server cannot be reached", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8888");
    };
    await expect(mem0Transport(fetcher, "http://localhost:8888/", undefined)("GET", "/memories")).rejects.toThrow("mem0 at http://localhost:8888 is unreachable: connect ECONNREFUSED");
  });

  it.each<[string, boolean]>([
    ["", true],
    ["https://api.mem0.ai", true],
    ["https://eu.api.mem0.ai/", true],
    ["http://localhost:8888", false],
    ["https://mem0.ai.example.com", false],
  ])("takes %j for the cloud: %s", (address, cloud) => expect(isMem0Cloud(address)).toBe(cloud));

  it.each([
    ["", "mem0"],
    ["https://api.mem0.ai", "mem0"],
    ["http://localhost:8888", "mem0-localhost-8888"],
    ["https://mem0.corp.example/api/", "mem0-mem0.corp.example-api"],
    ["http://me:secret@localhost:8888", "mem0-localhost-8888"],
  ])("names the store for %j %s", (address, name) => expect(mem0StoreName(address)).toBe(name));
});

describe("the mem0 cloud store", () => {
  it("adds an entry verbatim with the plugin's scope and the signature in flat metadata", async () => {
    const { calls, http } = fakeHttp([json(200, { status: "SUCCEEDED", results: [{ id: "uuid-1", event: "ADD" }] })]);
    expect(await mem0CloudStore(http, scope, project).put("gk-1", "# Title\n", undefined, signature)).toBe("uuid-1");
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v3/memories/add/",
        body: {
          messages: [{ role: "user", content: "# Title\n" }],
          infer: false,
          immutable: true,
          app_id: "BeeTrain-archivist",
          agent_id: "BeeTrain-archivist-0123456789",
          user_id: "dev-user",
          metadata,
        },
      },
    ]);
  });

  it("changes an entry by adding the new version, then deleting the old one", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [{ id: "uuid-2" }] }), json(204, {})]);
    expect(await mem0CloudStore(http, scope, project).put("gk-1", "# New\n", "uuid-1", signature)).toBe("uuid-2");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v3/memories/add/", "DELETE /v1/memories/uuid-1/"]);
  });

  it("keeps the new version when the old one cannot be deleted", async () => {
    const { http } = fakeHttp([json(200, { results: [{ id: "uuid-2" }] }), json(500, { detail: "busy" })]);
    expect(await mem0CloudStore(http, scope, project).put("gk-1", "# New\n", "uuid-1", signature)).toBe("uuid-2");
  });

  it("stops when mem0 refuses to delete the old version", async () => {
    const { http } = fakeHttp([json(200, { results: [{ id: "uuid-2" }] }), json(429, { detail: "quota" })]);
    await expect(mem0CloudStore(http, scope, project).put("gk-1", "# New\n", "uuid-1", signature)).rejects.toBeInstanceOf(MemoryRefused);
  });

  it("does not delete the item it just added when mem0 answers with the same id", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [{ id: "uuid-1" }] })]);
    expect(await mem0CloudStore(http, scope, project).put("gk-1", "# New\n", "uuid-1", signature)).toBe("uuid-1");
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("counts deleting an item that is gone as done, and fails on other errors", async () => {
    await expect(mem0CloudStore(fakeHttp([json(404, { detail: "not found" })]).http, scope, project).remove("uuid-1")).resolves.toBeUndefined();
    await expect(mem0CloudStore(fakeHttp([json(500, { detail: "busy" })]).http, scope, project).remove("uuid-1")).rejects.toThrow("HTTP 500");
  });

  it("lists the project's items with their text, page by page, through one filter", async () => {
    const item = (id: string, entry: string) => ({ id, memory: `# ${entry}\n`, metadata: { ...metadata, archivist_id: entry } });
    const { calls, http } = fakeHttp([
      json(200, { next: "https://api.mem0.ai/v3/memories/?page=2&page_size=200", results: [item("uuid-1", "gk-1"), { id: "uuid-x", memory: "someone else's", metadata: {} }] }),
      json(200, { next: null, results: [item("uuid-2", "cmd-1")] }),
    ]);
    expect(await mem0CloudStore(http, scope, project).list!()).toEqual({
      items: [
        { ref: "uuid-1", id: "gk-1", text: "# gk-1\n" },
        { ref: "uuid-2", id: "cmd-1", text: "# cmd-1\n" },
      ],
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v3/memories/?page=1&page_size=200",
      body: {
        filters: { AND: [{ app_id: "BeeTrain-archivist" }, { metadata: { archivist_project: project } }] },
        fields: ["id", "memory", "metadata", "updated_at"],
      },
    });
    expect(calls[1]?.path).toBe("/v3/memories/?page=2&page_size=200");
  });

  it("finds an entry by its key and takes the newest of two copies", async () => {
    const copy = (id: string, updated: string) => ({ id, memory: `# T\n\nProject: ${project} · Archivist gk-1 · updated ${updated}\n`, metadata });
    const { calls, http } = fakeHttp([json(200, { next: null, results: [copy("uuid-1", "2026-10-22T10:00:00.000Z"), copy("uuid-2", "2026-10-23T10:00:00.000Z")] })]);
    expect((await mem0CloudStore(http, scope, project).fetch!("gk-1"))?.ref).toBe("uuid-2");
    expect(calls[0]?.body).toMatchObject({ filters: { AND: [{ app_id: "BeeTrain-archivist" }, { metadata: { archivist_key: metadata.archivist_key } }] } });
  });

  it.each([401, 402, 403, 429])("stops on HTTP %i with what mem0 said", async (status) => {
    const failure = mem0CloudStore(fakeHttp([json(status, { detail: "Invalid API key" })]).http, scope, project).put("gk-1", "# T\n", undefined, signature);
    await expect(failure).rejects.toBeInstanceOf(MemoryRefused);
    await expect(failure).rejects.toThrow(`(HTTP ${status}): Invalid API key`);
  });

  it.each([400, 404, 422])("turns down a request mem0 answers with HTTP %i: the same request would not pass", async (status) => {
    const failure = mem0CloudStore(fakeHttp([json(status, { detail: "BYOK required" })]).http, scope, project).put("gk-1", "# T\n", undefined, signature);
    await expect(failure).rejects.toBeInstanceOf(MemoryRejected);
    await expect(failure).rejects.toThrow(`mem0 rejected the request (HTTP ${status}): BYOK required`);
  });

  it("keeps a server error for the next try", async () => {
    const error = await mem0CloudStore(fakeHttp([json(503, { detail: "busy" })]).http, scope, project)
      .put("gk-1", "# T\n", undefined, signature)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(MemoryRejected);
    expect(String(error)).toContain("mem0 request failed (HTTP 503): busy");
  });

  it("turns down an add that mem0 answers without storing anything", async () => {
    const failure = mem0CloudStore(fakeHttp([json(200, { results: [] })]).http, scope, project).put("gk-1", "# T\n", undefined, signature);
    await expect(failure).rejects.toBeInstanceOf(MemoryRejected);
    await expect(failure).rejects.toThrow("mem0 stored nothing");
  });

  it("gives a short reason when mem0 answers with something that is not JSON", async () => {
    const error = await mem0CloudStore(fakeHttp([{ status: 502, text: `<html>${"x".repeat(5000)}</html>` }]).http, scope, project)
      .remove("uuid-1")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("HTTP 502");
    expect(String(error).length).toBeLessThan(300);
  });

  it("gives a short reason when a successful answer is not JSON", async () => {
    const error = await mem0CloudStore(fakeHttp([{ status: 200, text: `<html>sign in to the proxy${" ".repeat(3000)}</html>` }]).http, scope, project)
      .list!()
      .catch((e: unknown) => e);
    expect(String(error)).toContain("mem0 answered with something that is not JSON (HTTP 200): <html>sign in to the proxy");
    expect(String(error).length).toBeLessThan(300);
    expect(error).toBeInstanceOf(MemoryRejected);
  });

  it("says its reads cost quota and its listing carries the text", () => {
    expect(mem0CloudStore(fakeHttp([]).http, scope, project)).toMatchObject({ name: "mem0", readsCostQuota: true, listsText: true });
  });
});

describe("the store on an own mem0 server", () => {
  const store = (http: HttpCall) => mem0ServerStore(http, scope, project, "mem0-localhost-8888");

  it("adds an entry verbatim with the scope, without app_id", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [{ id: "m-1", event: "ADD" }] })]);
    expect(await store(http).put("gk-1", "# Title\n", undefined, signature)).toBe("m-1");
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/memories",
        body: { messages: [{ role: "user", content: "# Title\n" }], infer: false, agent_id: scope.agentId, user_id: "dev-user", metadata },
      },
    ]);
  });

  it("changes an entry in place and keeps its id", async () => {
    const { calls, http } = fakeHttp([json(200, { message: "Memory updated successfully!" })]);
    expect(await store(http).put("gk-1", "# New\n", "m-1", signature)).toBe("m-1");
    expect(calls).toEqual([{ method: "PUT", path: "/memories/m-1", body: { text: "# New\n", metadata } }]);
  });

  it("adds the entry again when the item to change is gone", async () => {
    const { calls, http } = fakeHttp([json(404, { detail: "Memory with id m-1 not found" }), json(200, { results: [{ id: "m-2" }] })]);
    expect(await store(http).put("gk-1", "# New\n", "m-1", signature)).toBe("m-2");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /memories/m-1", "POST /memories"]);
  });

  it("lists the project's items with their text in one request for as many as the server gives", async () => {
    const { calls, http } = fakeHttp([
      json(200, {
        results: [
          { id: "m-1", memory: "# gk-1\n", metadata },
          { id: "m-9", memory: "another project", metadata: { ...metadata, archivist_project: "github.com/someone/else" } },
          { id: "m-8", memory: "not Archivist's", metadata: {} },
        ],
      }),
    ]);
    expect(await store(http).list!()).toEqual({ items: [{ ref: "m-1", id: "gk-1", text: "# gk-1\n" }], cut: false });
    expect(calls[0]).toEqual({ method: "GET", path: `/memories?agent_id=${encodeURIComponent(scope.agentId)}&top_k=1000` });
  });

  it("takes a listing the server sends as a bare array", async () => {
    const { http } = fakeHttp([json(200, [{ id: "m-1", memory: "# gk-1\n", metadata }])]);
    expect((await store(http).list!()).items).toEqual([{ ref: "m-1", id: "gk-1", text: "# gk-1\n" }]);
  });

  it("says the listing may be cut when it reached the server's limit", async () => {
    const results = Array.from({ length: 1000 }, (_, i) => ({ id: `m-${i}`, memory: "x", metadata: { ...metadata, archivist_id: `e-${i}` } }));
    expect((await store(fakeHttp([json(200, { results })]).http).list!()).cut).toBe(true);
  });

  it("reads an entry by its id, and searches the listing when that id is gone", async () => {
    expect(await store(fakeHttp([json(200, { id: "m-1", memory: "# gk-1\n", metadata })]).http).fetch!("gk-1", "m-1")).toEqual({ ref: "m-1", text: "# gk-1\n" });
    const gone = fakeHttp([json(200, null), json(200, { results: [{ id: "m-2", memory: "# gk-1 again\n", metadata }] })]);
    expect(await store(gone.http).fetch!("gk-1", "m-1")).toEqual({ ref: "m-2", text: "# gk-1 again\n" });
  });

  it("searches the listing when reading by id answers 404", async () => {
    const gone = fakeHttp([json(404, { detail: "Memory with id m-1 not found" }), json(200, { results: [{ id: "m-2", memory: "# gk-1 again\n", metadata }] })]);
    expect(await store(gone.http).fetch!("gk-1", "m-1")).toEqual({ ref: "m-2", text: "# gk-1 again\n" });
  });

  it("lists once for every entry it cannot read by id", async () => {
    const command = { ...metadata, archivist_key: `archivist/${project}/cmd-1`, archivist_id: "cmd-1" };
    const { calls, http } = fakeHttp([
      json(200, {
        results: [
          { id: "m-1", memory: "# gk-1\n", metadata },
          { id: "m-2", memory: "# cmd-1\n", metadata: command },
        ],
      }),
    ]);
    const own = store(http);
    expect((await own.fetch!("gk-1"))?.ref).toBe("m-1");
    expect((await own.fetch!("cmd-1"))?.ref).toBe("m-2");
    expect(calls).toHaveLength(1);
  });

  it("asks the server afresh each time its listing is wanted", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [] }), json(200, { results: [] })]);
    const own = store(http);
    await own.list!();
    await own.list!();
    expect(calls).toHaveLength(2);
  });

  it("counts deleting an item that is gone as done", async () => {
    const { calls, http } = fakeHttp([json(404, { detail: "Memory with id m-1 not found" })]);
    await expect(store(http).remove("m-1")).resolves.toBeUndefined();
    expect(calls[0]).toEqual({ method: "DELETE", path: "/memories/m-1" });
  });

  it("reads for free and carries the text in its listing", () => {
    expect(store(fakeHttp([]).http)).toMatchObject({ name: "mem0-localhost-8888", readsCostQuota: false, listsText: true });
  });
});

describe("searching mem0", () => {
  const fact = (id: string, score: number, extra: Record<string, unknown> = {}) => ({ id, memory: `fact ${id}`, score, created_at: "2026-10-20T10:00:00.000000+00:00", ...extra });
  const hit = (id: string) => ({ ref: id, text: `fact ${id}`, changed: "2026-10-20T10:00:00.000000+00:00" });
  const projectChannel = { AND: [{ agent_id: "BeeTrain-archivist-0123456789" }, { app_id: "BeeTrain-archivist" }] };
  const personalChannel = { AND: [{ user_id: "dev-user" }, { app_id: "BeeTrain-archivist" }] };

  it("looks only in the project's channel of the cloud for shared facts", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [fact("uuid-1", 0.9)] })]);
    expect(await mem0CloudStore(http, scope, project).search!("how to release", "shared")).toEqual([hit("uuid-1")]);
    expect(calls).toEqual([{ method: "POST", path: "/v3/memories/search/", body: { query: "how to release", filters: projectChannel, top_k: MEMORY_SEARCH_WIDTH } }]);
  });

  it("adds the user's own channel of the cloud when asked for all of it", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [] })]);
    expect(await mem0CloudStore(http, scope, project).search!("how to release", "all")).toEqual([]);
    expect(calls[0]?.body).toEqual({ query: "how to release", filters: { OR: [projectChannel, personalChannel] }, top_k: MEMORY_SEARCH_WIDTH });
  });

  it("knows an Archivist item of any project by its metadata", async () => {
    const { http } = fakeHttp([json(200, { results: [fact("uuid-1", 0.9, { metadata: { archivist_project: "github.com/acme/tools", archivist_id: "cmd-2" } }), fact("uuid-2", 0.8, { metadata: { source: "chat" } })] })]);
    expect(await mem0CloudStore(http, scope, project).search!("x", "shared")).toEqual([{ ...hit("uuid-1"), archivist: { project: "github.com/acme/tools", id: "cmd-2" } }, hit("uuid-2")]);
  });

  it("dates a fact by its last change: mem0 may fold new facts into an old memory", async () => {
    const { http } = fakeHttp([json(200, { results: [fact("uuid-1", 0.9, { updated_at: "2026-11-06T10:00:00.000000+00:00" })] })]);
    expect(await mem0CloudStore(http, scope, project).search!("x", "shared")).toEqual([{ ...hit("uuid-1"), changed: "2026-11-06T10:00:00.000000+00:00" }]);
  });

  it("leaves out a result with no id or no text", async () => {
    const { http } = fakeHttp([json(200, { results: [{ id: "uuid-1", score: 0.9 }, { memory: "no id", score: 0.8 }, fact("uuid-2", 0.7)] })]);
    expect(await mem0CloudStore(http, scope, project).search!("x", "shared")).toEqual([hit("uuid-2")]);
  });

  it("passes on a refusal and a rejection of the search", async () => {
    await expect(mem0CloudStore(fakeHttp([json(429, { detail: "quota" })]).http, scope, project).search!("x", "shared")).rejects.toBeInstanceOf(MemoryRefused);
    await expect(mem0CloudStore(fakeHttp([json(400, { detail: "bad filter" })]).http, scope, project).search!("x", "shared")).rejects.toBeInstanceOf(MemoryRejected);
  });

  it("names the project's channel at the top of the filter on an own server, as it demands", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [fact("uuid-1", 0.9)] })]);
    expect(await mem0ServerStore(http, scope, project, "mem0-localhost-8888").search!("how to release", "shared")).toEqual([hit("uuid-1")]);
    expect(calls).toEqual([{ method: "POST", path: "/search", body: { query: "how to release", filters: { agent_id: "BeeTrain-archivist-0123456789" }, top_k: MEMORY_SEARCH_WIDTH } }]);
  });

  it("asks an own server about each channel apart and joins the answers by score, without repeats", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [fact("uuid-1", 0.5), fact("uuid-2", 0.4)] }), json(200, { results: [fact("uuid-3", 0.9), fact("uuid-1", 0.5)] })]);
    expect(await mem0ServerStore(http, scope, project, "mem0-localhost-8888").search!("x", "all")).toEqual([hit("uuid-3"), hit("uuid-1"), hit("uuid-2")]);
    expect(calls.map((c) => (c.body as { filters: unknown }).filters)).toEqual([{ agent_id: "BeeTrain-archivist-0123456789" }, { user_id: "dev-user" }]);
  });

  it("takes an answer an own server sends as a bare array", async () => {
    const { http } = fakeHttp([json(200, [fact("uuid-1", 0.9)])]);
    expect(await mem0ServerStore(http, scope, project, "mem0-localhost-8888").search!("x", "shared")).toEqual([hit("uuid-1")]);
  });
});
