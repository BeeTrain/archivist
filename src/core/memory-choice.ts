import type { Config } from "./config.js";
import { isMem0Cloud, MEM0_CLOUD_URL, mem0StoreName } from "./memory-mem0.js";

export type MemoryKind = "auto" | "openviking" | "mem0" | "off";

export interface MemoryOptions {
  memory: MemoryKind;
  url: string;
  apiKey: string;
  cloudProjects: string[];
}

export const CLOUD_PROJECTS_OPTION = "memory_cloud_projects";

const MEMORY_KINDS: MemoryKind[] = ["auto", "openviking", "mem0", "off"];

const textOption = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const sameProject = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const projectEntries = (value: unknown): string[] => {
  const entries: string[] = [];
  for (const raw of Array.isArray(value) ? value : [value]) {
    if (typeof raw !== "string") continue;
    for (const entry of raw.split(/[\s,]+/)) if (entry && !entries.some((known) => sameProject(known, entry))) entries.push(entry);
  }
  return entries;
};

export const readMemoryOptions = (options: Readonly<Record<string, unknown>>): MemoryOptions => ({
  memory: MEMORY_KINDS.find((kind) => kind === options.memory) ?? "auto",
  url: textOption(options.memory_url),
  apiKey: textOption(options.memory_api_key),
  cloudProjects: projectEntries(options[CLOUD_PROJECTS_OPTION]),
});

export const cloudAllowedBy = (project: string, entries: readonly string[]): string | undefined => {
  const id = project.toLowerCase();
  return entries.find((entry) => {
    const allowed = entry.trim().toLowerCase();
    return allowed === "*" || allowed === id || (allowed.endsWith("/*") && id.startsWith(allowed.slice(0, -1)));
  });
};

export const withCloudProject = (entries: readonly string[], project: string): string[] => (entries.some((entry) => sameProject(entry, project)) ? [...entries] : [...entries, project]);

export const withoutCloudProject = (entries: readonly string[], project: string): string[] => entries.filter((entry) => !sameProject(entry, project));

export type MemoryChoice =
  | { kind: "none"; why: string }
  | { kind: "openviking"; server: string }
  | { kind: "mem0"; base: string; cloud: boolean; key: string | undefined; allowed: boolean };

const parsedUrl = (address: string): URL | undefined => {
  try {
    return new URL(address);
  } catch {
    return undefined;
  }
};

const addressProblem = (address: string): string | undefined => {
  const url = parsedUrl(address);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "The mem0 address in /config is not an http:// or https:// URL, such as http://localhost:8888.";
  if (url.username || url.password) return "The mem0 address in /config has a user name or password in it: put the key under mem0 API key instead.";
  return undefined;
};

export const chooseMemory = (args: { options: MemoryOptions; project: string; envKey: string | undefined; openVikingServer: string | undefined }): MemoryChoice => {
  const { options, project, envKey, openVikingServer } = args;
  if (options.memory === "off") return { kind: "none", why: "External memory is off in the plugin options (/config): entries stay in project files." };
  if (options.memory !== "mem0") {
    if (openVikingServer) return { kind: "openviking", server: openVikingServer };
    return {
      kind: "none",
      why:
        options.memory === "openviking"
          ? "OpenViking is chosen in /config, but it is not connected to this session."
          : "No OpenViking is connected to this session; to use mem0, choose it under External memory in /config.",
    };
  }
  const problem = options.url ? addressProblem(options.url) : undefined;
  if (problem) return { kind: "none", why: problem };
  const cloud = isMem0Cloud(options.url);
  const key = options.apiKey || (cloud ? envKey?.trim() || undefined : undefined);
  if (cloud && !key) return { kind: "none", why: "mem0 cloud is chosen, but it has no key: set the mem0 API key in /config, or MEM0_API_KEY in the environment." };
  return { kind: "mem0", base: options.url || MEM0_CLOUD_URL, cloud, key, allowed: !cloud || cloudAllowedBy(project, options.cloudProjects) !== undefined };
};

export const memoryWhere = (choice: MemoryChoice): string => {
  if (choice.kind === "openviking") return choice.server;
  if (choice.kind === "mem0") return choice.cloud ? "mem0 cloud" : `mem0 at ${choice.base}`;
  return "";
};

export const storeNameFor = (options: MemoryOptions): string | undefined => {
  if (options.memory === "off") return undefined;
  return options.memory === "mem0" ? mem0StoreName(options.url) : "openviking";
};

export const memorySyncBlock = (config: Config, choice: MemoryChoice, project: string): string | undefined => {
  if (!config.enabled) return "Archivist is off in this project: enabled is false in .archivist/config.json.";
  if (!config.memory.enabled) return "Memory sync is off: set memory.enabled to true in .archivist/config.json.";
  if (choice.kind === "none") return choice.why;
  if (choice.kind === "mem0" && !choice.allowed) return `mem0 cloud is chosen, but ${project} is not sent there: /archivist memory on sends it.`;
  return undefined;
};
