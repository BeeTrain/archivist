import type { Config } from "./config.js";
import { messageOf, type MemoryHit, type MemoryReach, type MemoryStore } from "./memory.js";
import { memorySyncBlock, type MemoryPlace } from "./memory-choice.js";
import { redact } from "./privacy.js";
import { truncate } from "./text.js";

export interface MemoryReader {
  project: string;
  where: string;
  search(query: string, reach: MemoryReach): Promise<MemoryHit[]>;
}

export interface MemoryFact {
  source: string;
  text: string;
}

const QUERY_PROMPT_CHARS = 200;
const FILES_IN_QUERY = 5;
const FACT_CHARS = 300;
const SOURCE_CHARS = 200;
const FACTS_FOR_CURATOR = 8;
const FACTS_FOR_RECALL = 5;
const SEARCH_TIMEOUT_MS = 20_000;

const MASK = "[redacted]";
const CREDENTIAL_NEAR_ITS_NAME =
  /(?<![\p{L}\p{N}_])(?:pass(?:word|wd|phrase)|secret|token|bearer|api[ _-]?key|access[ _-]?key|парол\p{L}*|токен\p{L}*|секрет\p{L}*|ключ\p{L}*)(?:\s+\p{L}+){0,2}[\s:=]+["']?\S*[\d!@#$%^&*]\S*/giu;
const LONG_RUN = /\S{20,}/g;
const OUTSIDE_THE_PROJECT = /^(\/|~|[A-Za-z]:[\\/])/;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const cleanLine = (text: string, max: number): string => truncate(redact(oneLine(text)).text, max);

const withoutCredentials = (text: string): string =>
  redact(text)
    .text.replace(CREDENTIAL_NEAR_ITS_NAME, MASK)
    .replace(LONG_RUN, (run) => (/\p{L}/u.test(run) && /\d/.test(run) ? MASK : run));

export const memoryQuery = (prompt: string | undefined, edits: string[]): string => {
  const files = edits.filter((file) => !OUTSIDE_THE_PROJECT.test(file)).slice(0, FILES_IN_QUERY);
  return [truncate(withoutCredentials(oneLine(prompt ?? "")), QUERY_PROMPT_CHARS), ...files.map((file) => cleanLine(file, SOURCE_CHARS))].join(" ").trim();
};

const factOf = (hit: MemoryHit): MemoryFact => ({
  source: cleanLine(hit.archivist ? `${hit.archivist.project} · Archivist ${hit.archivist.id}` : hit.ref, SOURCE_CHARS),
  text: cleanLine(hit.text, FACT_CHARS),
});

export const factLine = (fact: MemoryFact): string => `- (${fact.source}) ${fact.text}`;

const inThisLedger = (hit: MemoryHit, project: string, known: ReadonlySet<string>): boolean => hit.archivist?.project === project && known.has(hit.archivist.id);

const changedSince = (hit: MemoryHit, startedAt: number): boolean => hit.changed !== undefined && Date.parse(hit.changed) >= startedAt;

export const factsForCurator = (hits: MemoryHit[], task: { project: string; known: ReadonlySet<string>; startedAt: number }): MemoryFact[] =>
  hits
    .filter((hit) => !hit.archivist || hit.archivist.project === task.project)
    .filter((hit) => !inThisLedger(hit, task.project, task.known) && !changedSince(hit, task.startedAt))
    .slice(0, FACTS_FOR_CURATOR)
    .map(factOf);

export const factsForTask = async (
  memory: MemoryReader | undefined,
  task: { prompt: string | undefined; edits: string[]; known: ReadonlySet<string>; startedAt: number },
): Promise<{ facts: MemoryFact[]; note?: string }> => {
  const query = memoryQuery(task.prompt, task.edits);
  if (!memory || !query) return { facts: [] };
  try {
    const facts = factsForCurator(await memory.search(query, "shared"), { project: memory.project, known: task.known, startedAt: task.startedAt });
    return facts.length ? { facts, note: `memory facts shown to the curator: ${facts.length}` } : { facts };
  } catch (err) {
    return { facts: [], note: `memory search failed: ${messageOf(err)}` };
  }
};

export const recallAcross = async (args: { journal: string; memory: MemoryReader | undefined; query: string; known: ReadonlySet<string> }): Promise<string> => {
  const { journal, memory, known } = args;
  const query = memoryQuery(args.query, []);
  if (!memory || !query) return journal;
  try {
    const hits = (await memory.search(query, "all")).filter((hit) => !inThisLedger(hit, memory.project, known));
    if (!hits.length) return `${journal}\n\nNothing about it in ${memory.where}.`;
    const lines = hits.slice(0, FACTS_FOR_RECALL).map(factOf).map((fact) => `- ${fact.text} (${fact.source})`);
    return [journal, "", `From ${memory.where}:`, ...lines].join("\n");
  } catch (err) {
    return `${journal}\n\nMemory search failed: ${messageOf(err)}`;
  }
};

const answeredBy = <T>(work: Promise<T>, deadline: Promise<unknown>): Promise<T> =>
  Promise.race([
    work,
    deadline.then(() => {
      throw new Error(`no answer in ${SEARCH_TIMEOUT_MS / 1000} seconds`);
    }),
  ]);

export const openMemoryReader = async (args: {
  config: Config;
  place: MemoryPlace;
  store: () => Promise<MemoryStore | undefined>;
  sleep: (ms: number) => Promise<unknown>;
}): Promise<MemoryReader | undefined> => {
  const { config, place, store, sleep } = args;
  if (memorySyncBlock(config, place.choice, place.project)) return undefined;
  const search = (await store())?.search;
  if (!search) return undefined;
  return { project: place.project, where: place.where, search: (query, reach) => answeredBy(search(query, reach), sleep(SEARCH_TIMEOUT_MS)) };
};
