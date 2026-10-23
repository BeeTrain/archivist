import { PATHS, type Io } from "./io.js";
import { foldLedger, parseLedger } from "./ledger.js";
import { withLock } from "./lock.js";
import { findStale } from "./render.js";
import type { Entry, EntryType } from "./types.js";

export interface MemoryStore {
  name: string;
  put(id: string, text: string, ref?: string): Promise<string>;
  remove(ref: string): Promise<void>;
  fetch?(id: string): Promise<{ ref: string; text: string } | undefined>;
  list?(): Promise<{ ref: string; id: string }[]>;
}

export interface SentItem {
  ref: string;
  text: string;
  updated: string;
}

export interface MemoryCache {
  store: string;
  project: string;
  items: Record<string, SentItem>;
  ledgerMark?: string;
  lastSync?: string;
  lastError?: string;
  missing?: string[];
  unknown?: string[];
}

export interface SyncOutcome {
  written: string[];
  adopted: string[];
  removed: string[];
  newer: string[];
  missing: string[];
  unknown: string[];
  failed: { id: string; error: string }[];
}

export interface Signature {
  project: string;
  id: string;
  updated: string;
}

const segment = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const localProject = (path: string): string => `local/${segment(path.replace(/\.git$/, "").split("/").filter(Boolean).at(-1) ?? "project") || "project"}`;

const hostAndPath = (remote: string): [string, string] | undefined => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    const url = new URL(remote);
    return url.hostname ? [url.hostname, url.pathname] : undefined;
  }
  const scp = remote.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  return scp ? [scp[1]!, scp[2]!] : undefined;
};

export const projectId = (remote: string | undefined, root: string): string => {
  const url = remote?.trim();
  const parts = url ? hostAndPath(url) : undefined;
  if (!parts) return localProject(url || root);
  const [host, path] = parts;
  return [host, ...path.replace(/\.git$/, "").split("/")]
    .map(segment)
    .filter(Boolean)
    .join("/");
};

const TYPE_LABEL: Record<EntryType, string> = { command: "Command", gotcha: "Gotcha", decision: "Decision", procedure: "Procedure" };

const signatureLine = (e: Entry, project: string): string =>
  [`Project: ${project}`, `Archivist ${e.id}`, ...(e.adr ? [`ADR-${String(e.adr).padStart(4, "0")}`] : []), `updated ${e.updated}`].join(" · ");

export const renderItem = (e: Entry, project: string): string => {
  const label = TYPE_LABEL[e.type];
  return [
    `# ${e.title}`,
    "",
    e.content.includes("\n") ? `${label}:\n${e.content}` : `${label}: ${e.content}`,
    ...(e.rationale ? [`Why: ${e.rationale}`] : []),
    ...(e.scope?.paths.length ? [`Where: ${e.scope.paths.join(", ")}`] : []),
    "",
    signatureLine(e, project),
    "",
  ].join("\n");
};

const SIGNATURE = /^Project: (.+?) · Archivist (\S+)(?: · ADR-\d+)? · updated (\S+)$/;

export const readSignature = (text: string): Signature | undefined => {
  const match = (text.trimEnd().split("\n").at(-1) ?? "").match(SIGNATURE);
  return match ? { project: match[1]!, id: match[2]!, updated: match[3]! } : undefined;
};

const noOutcome = (): SyncOutcome => ({ written: [], adopted: [], removed: [], newer: [], missing: [], unknown: [], failed: [] });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const reconcile = async (args: {
  store: MemoryStore;
  entries: Map<string, Entry>;
  stale: Set<string>;
  cache: MemoryCache;
  verify: boolean;
}): Promise<{ cache: MemoryCache; outcome: SyncOutcome }> => {
  const { store, entries, stale, cache, verify } = args;
  const items = { ...cache.items };
  const outcome = noOutcome();
  const present = verify && store.list ? new Map((await store.list()).map((item) => [item.id, item.ref])) : undefined;
  for (const e of entries.values()) {
    const sent = items[e.id];
    try {
      if (e.status !== "active") {
        const ref = sent?.ref ?? present?.get(e.id);
        if (!ref) continue;
        await store.remove(ref);
        delete items[e.id];
        outcome.removed.push(e.id);
        continue;
      }
      if (stale.has(e.id)) continue;
      const text = renderItem(e, cache.project);
      if (sent?.text === text) {
        if (present && !present.has(e.id)) outcome.missing.push(e.id);
        continue;
      }
      const remote = await store.fetch?.(e.id);
      const remoteUpdated = remote ? readSignature(remote.text)?.updated : undefined;
      if (remoteUpdated && remoteUpdated > e.updated) {
        outcome.newer.push(e.id);
        continue;
      }
      if (remote && remote.text.trimEnd() === text.trimEnd()) {
        items[e.id] = { ref: remote.ref, text, updated: e.updated };
        outcome.adopted.push(e.id);
        continue;
      }
      const ref = await store.put(e.id, text, sent?.ref ?? remote?.ref);
      items[e.id] = { ref, text, updated: e.updated };
      outcome.written.push(e.id);
    } catch (err) {
      outcome.failed.push({ id: e.id, error: messageOf(err) });
    }
  }
  if (present) for (const id of present.keys()) if (!entries.has(id)) outcome.unknown.push(id);
  return { cache: { ...cache, items, ...(present ? { missing: outcome.missing, unknown: outcome.unknown } : {}) }, outcome };
};

export const memoryOutcomeText = (outcome: SyncOutcome): string => {
  const counts: [number, string][] = [
    [outcome.written.length, "written"],
    [outcome.adopted.length, "already there"],
    [outcome.removed.length, "removed"],
    [outcome.newer.length, "newer in memory"],
    [outcome.missing.length, "gone from memory"],
    [outcome.unknown.length, "unknown to this ledger"],
    [outcome.failed.length, "failed"],
  ];
  const said = counts.filter(([n]) => n).map(([n, what]) => `${n} ${what}`);
  const firstFailure = outcome.failed[0];
  return said.length ? `${said.join(", ")}${firstFailure ? ` (${firstFailure.id}: ${firstFailure.error})` : ""}` : "nothing to do";
};

export const memoryCachePath = (store: string): string => `.archivist/.local/memory-${store}.json`;

export const loadMemoryCache = async (io: Io, store: string, project: string): Promise<MemoryCache> => {
  const fresh: MemoryCache = { store, project, items: {} };
  try {
    const saved = JSON.parse((await io.read(memoryCachePath(store))) ?? "null") as MemoryCache | null;
    return saved?.store === store && saved.project === project && saved.items ? saved : fresh;
  } catch {
    return fresh;
  }
};

export const loadMemoryCaches = async (io: Io): Promise<MemoryCache[]> => {
  const caches: MemoryCache[] = [];
  for (const name of await io.list(".archivist/.local")) {
    const store = name.match(/^memory-(.+)\.json$/)?.[1];
    if (!store) continue;
    try {
      const cache = JSON.parse((await io.read(memoryCachePath(store))) ?? "null") as MemoryCache | null;
      if (cache?.items) caches.push(cache);
    } catch {
      continue;
    }
  }
  return caches;
};

export const ledgerMark = (text: string): string => `${text.length}:${text.slice(-64)}`;

export const memoryUpToDate = async (io: Io): Promise<boolean> => {
  const caches = await loadMemoryCaches(io);
  const mark = ledgerMark((await io.read(PATHS.ledger)) ?? "");
  return caches.length > 0 && caches.every((cache) => cache.ledgerMark === mark && !cache.lastError);
};

export const clearMemory = async (io: Io, store: MemoryStore, project: string): Promise<string[]> => {
  const removed: string[] = [];
  for (const item of (await store.list?.()) ?? []) {
    const remote = await store.fetch?.(item.id);
    if (!remote || readSignature(remote.text)?.project !== project) continue;
    await store.remove(item.ref);
    removed.push(item.id);
  }
  const forgotten: MemoryCache = { store: store.name, project, items: {} };
  await withLock(io, () => io.write(memoryCachePath(store.name), JSON.stringify(forgotten, null, 1) + "\n"));
  return removed;
};

export const syncMemory = async (args: { io: Io; store: MemoryStore; project: string; mode: "fast" | "verify"; now: string }): Promise<SyncOutcome | undefined> => {
  const { io, store, project, mode, now } = args;
  const ledgerText = (await io.read(PATHS.ledger)) ?? "";
  const mark = ledgerMark(ledgerText);
  const cache = await loadMemoryCache(io, store.name, project);
  const firstSync = !cache.lastSync;
  if (mode === "fast" && !firstSync && cache.ledgerMark === mark && !cache.lastError) return undefined;
  const entries = foldLedger(parseLedger(ledgerText).records);
  const { cache: next, outcome } = await reconcile({ store, entries, stale: await findStale(io, entries), cache, verify: mode === "verify" || firstSync });
  const failure = outcome.failed[0];
  const saved: MemoryCache = { ...next, ledgerMark: mark, lastSync: now, lastError: failure ? `${failure.id}: ${failure.error}` : undefined };
  await withLock(io, () => io.write(memoryCachePath(store.name), JSON.stringify(saved, null, 1) + "\n"));
  return outcome;
};
