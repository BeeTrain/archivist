import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface WorkspaceRegistry {
  v: 1;
  lastRoot?: string;
  projects: { root: string; updatedAt: string }[];
  conversations: Record<string, { root: string; updatedAt: string }>;
}

const MAX_PROJECTS = 30;
const MAX_CONVERSATIONS = 200;

export const registryPath = (): string =>
  process.env.ARCHIVIST_ANTIGRAVITY_STATE || join(homedir(), ".gemini", "antigravity", "archivist-state.json");

const emptyRegistry = (): WorkspaceRegistry => ({ v: 1, projects: [], conversations: {} });

export const readRegistry = async (): Promise<WorkspaceRegistry> => {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceRegistry>;
    return {
      v: 1,
      ...(typeof parsed.lastRoot === "string" ? { lastRoot: parsed.lastRoot } : {}),
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.filter((p): p is { root: string; updatedAt: string } => Boolean(p && typeof p.root === "string"))
        : [],
      conversations:
        parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {},
    };
  } catch {
    return emptyRegistry();
  }
};

const writeRegistry = async (reg: WorkspaceRegistry): Promise<void> => {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
};

export const registerWorkspace = async (root: string, conversationId?: string): Promise<WorkspaceRegistry> => {
  const abs = resolve(root);
  const now = new Date().toISOString();
  const reg = await readRegistry();
  reg.lastRoot = abs;
  reg.projects = [
    { root: abs, updatedAt: now },
    ...reg.projects.filter((p) => p.root !== abs && existsSync(p.root)),
  ].slice(0, MAX_PROJECTS);

  if (conversationId && conversationId.trim()) {
    reg.conversations[conversationId] = { root: abs, updatedAt: now };
    const entries = Object.entries(reg.conversations).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
    reg.conversations = Object.fromEntries(entries.slice(0, MAX_CONVERSATIONS));
  }

  await writeRegistry(reg).catch(() => {});
  return reg;
};

export const resolveActiveWorkspace = async (opts: { root?: string; conversationId?: string }): Promise<{
  root?: string;
  projects: { root: string; updatedAt: string }[];
}> => {
  const reg = await readRegistry();
  const projects = reg.projects.filter((p) => existsSync(p.root));
  if (opts.root && opts.root.trim()) {
    const abs = resolve(opts.root);
    if (existsSync(abs)) {
      const merged = projects.some((p) => p.root === abs)
        ? projects
        : [{ root: abs, updatedAt: new Date().toISOString() }, ...projects];
      return { root: abs, projects: merged };
    }
  }
  if (opts.conversationId && reg.conversations[opts.conversationId]) {
    const mapped = reg.conversations[opts.conversationId]!.root;
    if (existsSync(mapped)) return { root: mapped, projects };
  }
  if (reg.lastRoot && existsSync(reg.lastRoot)) {
    return { root: reg.lastRoot, projects };
  }
  return { root: projects[0]?.root, projects };
};
