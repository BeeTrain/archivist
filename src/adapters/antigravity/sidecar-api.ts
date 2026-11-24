import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findRoot, nodeIo } from "../../cli/node-io.js";
import { scanCommands } from "../../cli/scan.js";
import { DEFAULT_CONFIG, loadConfig } from "../../core/config.js";
import { PATHS, type Io } from "../../core/io.js";
import { activeEntries, appendLedger, loadState } from "../../core/ledger.js";
import { withLock } from "../../core/lock.js";
import { lint } from "../../core/maintenance.js";
import { renderAll } from "../../core/render.js";
import {
  addEntry,
  applyProposals,
  deprecateEntry,
  listProposals,
  needsHuman,
  skipProposals,
  type Proposal,
} from "../../core/review.js";
import { ENTRY_TYPES, type Entry, type EntryType } from "../../core/types.js";
import { validateOps } from "../../core/validate.js";
import { collectionStats, type CollectionStats } from "./hooks.js";
import { analysisStatus, runWorker } from "./queue.js";
import { registerWorkspace, resolveActiveWorkspace } from "./registry.js";

export interface SidecarProposalView {
  id: string;
  fingerprint: string;
  human: boolean;
  kind: string;
  title: string;
  content: string;
  rationale?: string;
  reason: string | null;
}

export interface SidecarEntryView {
  id: string;
  type: EntryType;
  title: string;
  content: string;
  rationale?: string;
  paths: string[];
  updated: string;
}

export interface SidecarSnapshot {
  root: string | null;
  project: string;
  projects: { root: string; name: string; updatedAt: string }[];
  initialized: boolean;
  enabled: boolean;
  counts: {
    entries: number;
    deprecated: number;
    review: number;
    reports: number;
  };
  entries: SidecarEntryView[];
  matching: number;
  proposals: SidecarProposalView[];
  analysis: {
    enabled: boolean;
    tasks: { state: string; message: string; updatedAt: number }[];
  };
  collection: CollectionStats;
  reports: string[];
  updatedAt: string;
}

const fingerprint = (proposal: Proposal): string =>
  createHash("sha256").update(JSON.stringify(proposal.op)).digest("hex");

const proposalView = (proposal: Proposal, entries: Map<string, Entry>): SidecarProposalView => {
  const op = proposal.op;
  const existing = "id" in op ? entries.get(op.id) : undefined;
  const types: Record<EntryType, string> = {
    command: "Команда",
    gotcha: "Ловушка",
    decision: "Решение",
    procedure: "Процедура",
  };
  const changes = {
    update: "Обновление записи",
    reinforce: "Подтверждение записи",
    deprecate: "Удаление из действующих знаний",
  };
  return {
    id: proposal.id,
    fingerprint: fingerprint(proposal),
    human: needsHuman(op),
    kind: op.op === "add" ? types[op.type] : changes[op.op],
    title:
      op.op === "add"
        ? op.title
        : op.op === "update"
          ? op.title ?? existing?.title ?? op.id
          : existing?.title ?? op.id,
    content:
      op.op === "add"
        ? op.content
        : op.op === "update"
          ? op.content ?? existing?.content ?? ""
          : op.op === "deprecate"
            ? op.reason
            : "Запись снова подтвердилась при работе над задачей.",
    ...(op.op === "add" && op.rationale ? { rationale: op.rationale } : {}),
    reason:
      proposal.reason
        ?.replace(/^(?:codex|opencode|antigravity|adapter): review required$/i, "Ожидает проверки")
        .replaceAll("evidence file not found:", "Не найден подтверждающий файл:") ?? null,
  };
};

const readDocs = async (io: Io): Promise<string[]> => {
  const out: string[] = [];
  for (const p of ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "GEMINI.md", "README.md"]) {
    const t = await io.read(p);
    if (t) out.push(t);
  }
  return out;
};

export const uiSnapshot = async (opts: {
  root?: string;
  conversationId?: string;
  query?: string;
  type?: string;
}): Promise<SidecarSnapshot> => {
  const resolved = await resolveActiveWorkspace({ root: opts.root, conversationId: opts.conversationId });
  const projects = resolved.projects.map((p) => ({ root: p.root, name: basename(p.root) || p.root, updatedAt: p.updatedAt }));
  if (!resolved.root) {
    return {
      root: null,
      project: "Проект не выбран",
      projects,
      initialized: false,
      enabled: true,
      counts: { entries: 0, deprecated: 0, review: 0, reports: 0 },
      entries: [],
      matching: 0,
      proposals: [],
      analysis: { enabled: false, tasks: [] },
      collection: { sessions: 0, events: 0, counts: {}, modelCallsUpperBound: 0, contentCaptured: false, analysisEnabled: false },
      reports: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const root = findRoot(resolved.root);
  const io = nodeIo(root, "antigravity");
  const [initialized, config, state, proposals, analysis, collection, reportsList] = await Promise.all([
    io.exists(PATHS.dir),
    loadConfig(io),
    loadState(io),
    listProposals(io),
    analysisStatus(io),
    collectionStats(root),
    io.list(PATHS.reports),
  ]);

  const allActive = activeEntries(state.entries).sort(
    (a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id),
  );
  const query = (opts.query ?? "").trim().toLocaleLowerCase();
  const typeFilter = opts.type && ENTRY_TYPES.includes(opts.type as EntryType) ? (opts.type as EntryType) : undefined;

  const filtered = allActive.filter((e) => {
    if (typeFilter && e.type !== typeFilter) return false;
    if (!query) return true;
    return [e.title, e.content, e.rationale ?? "", e.type, e.id, ...(e.scope?.paths ?? [])].some((s) =>
      s.toLocaleLowerCase().includes(query),
    );
  });

  const reports = reportsList.filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 30);

  return {
    root,
    project: basename(root) || root,
    projects,
    initialized,
    enabled: config.enabled,
    counts: {
      entries: allActive.length,
      deprecated: state.entries.size - allActive.length,
      review: proposals.length,
      reports: reports.length,
    },
    entries: filtered.slice(0, 300).map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      content: e.content,
      ...(e.rationale ? { rationale: e.rationale } : {}),
      paths: e.scope?.paths ?? [],
      updated: e.updated,
    })),
    matching: filtered.length,
    proposals: proposals.map((p) => proposalView(p, state.entries)),
    analysis,
    collection,
    reports,
    updatedAt: new Date().toISOString(),
  };
};

export const uiReport = async (root: string, file?: string): Promise<{ file: string | null; text: string }> => {
  const io = nodeIo(findRoot(root), "antigravity");
  const reports = (await io.list(PATHS.reports)).filter((f) => f.endsWith(".md")).sort();
  const chosen = file && /^[A-Za-z0-9._-]+\.md$/.test(file) ? file : reports.at(-1);
  if (!chosen) return { file: null, text: "Отчёт появится после первого анализа задачи." };
  const text = (await io.read(`${PATHS.reports}/${chosen}`)) ?? "Отчёт не найден.";
  return { file: chosen, text: text.slice(0, 100_000) };
};

export const uiInit = async (rootInput: string): Promise<{ root: string; added: number; written: string[] }> => {
  const root = findRoot(resolve(rootInput));
  if (!existsSync(root)) throw new Error(`Каталог не найден: ${root}`);
  await registerWorkspace(root);
  const io = nodeIo(root, "antigravity");
  return withLock(io, async () => {
    if (!(await io.exists(PATHS.config))) {
      await io.write(PATHS.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    }
    if (!(await io.exists(PATHS.gitignore))) {
      await io.write(PATHS.gitignore, ".local/\n");
    }
    const config = await loadConfig(io);
    const state = await loadState(io);
    const v = await validateOps({
      ops: await scanCommands(io, config.language),
      entries: state.entries,
      io,
      config,
      docs: await readDocs(io),
      now: new Date().toISOString(),
      source: "init",
    });
    await appendLedger(io, v.records);
    const rendered = await renderAll(io, (await loadState(io)).entries, config);
    return { root, added: v.applied.length, written: rendered.written };
  });
};

export const uiSettle = async (
  rootInput: string,
  input: { id: string; fingerprint: string; action: "apply" | "skip" },
): Promise<{ text: string }> => {
  const io = nodeIo(findRoot(rootInput), "antigravity");
  const proposal = (await listProposals(io)).find((p) => p.id === input.id);
  if (!proposal || fingerprint(proposal) !== input.fingerprint) {
    throw new Error("Предложение изменилось или уже разобрано. Обновите очередь.");
  }
  const now = new Date().toISOString();
  if (input.action === "skip") {
    const count = await skipProposals(io, [proposal], now);
    if (!count) throw new Error("Предложение уже разобрано.");
    return { text: "Предложение отклонено" };
  }
  const outcomes = await applyProposals(io, await loadConfig(io), [proposal], now);
  if (!outcomes.some((o) => o.id)) {
    throw new Error(outcomes[0]?.reason ?? "Не удалось применить предложение.");
  }
  return { text: "Предложение принято" };
};

export const uiAdd = async (
  rootInput: string,
  input: { type: string; title: string; content: string; rationale?: string; paths?: string },
): Promise<{ text: string; id: string }> => {
  const type = input.type as EntryType;
  if (!ENTRY_TYPES.includes(type)) throw new Error("Укажите тип: command, gotcha, decision или procedure");
  const title = input.title?.trim();
  const content = input.content?.trim();
  if (!title || !content) throw new Error("Заполните заголовок и содержание");
  if (type === "decision" && !input.rationale?.trim()) {
    throw new Error("Для решения укажите причину (why)");
  }
  const io = nodeIo(findRoot(rootInput), "antigravity");
  const paths = (input.paths ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const outcomes = await addEntry(
    io,
    await loadConfig(io),
    {
      type,
      title,
      content,
      ...(input.rationale?.trim() ? { rationale: input.rationale.trim() } : {}),
      paths,
      evidence: [],
    },
    new Date().toISOString(),
  );
  const created = outcomes.find((o) => o.id);
  if (!created?.id) throw new Error(outcomes[0]?.reason ?? "Запись не была добавлена");
  return { text: `Добавлено: ${title}`, id: created.id };
};

export const uiDeprecate = async (
  rootInput: string,
  input: { id: string; reason: string },
): Promise<{ text: string }> => {
  if (!input.id?.trim()) throw new Error("Не указан ID записи");
  const io = nodeIo(findRoot(rootInput), "antigravity");
  const result = await deprecateEntry(
    io,
    await loadConfig(io),
    input.id.trim(),
    input.reason?.trim() || "Устарело",
    new Date().toISOString(),
  );
  if (!result.ok) throw new Error(result.reason);
  return { text: `Запись выведена из правил: ${result.entry.title}` };
};

export const uiAnalysis = async (
  rootInput: string,
  action: "enable" | "disable" | "run",
): Promise<{ enabled: boolean; tasks: { state: string; message: string; updatedAt: number }[]; text: string }> => {
  const root = findRoot(rootInput);
  const io = nodeIo(root, "antigravity");
  if (action === "enable" || action === "disable") {
    await withLock(io, async () => {
      const raw = JSON.parse((await io.read(PATHS.config)) ?? "{}") as Record<string, unknown>;
      const prev = raw.antigravity && typeof raw.antigravity === "object" ? (raw.antigravity as Record<string, unknown>) : {};
      await io.write(
        PATHS.config,
        JSON.stringify({ ...raw, antigravity: { ...prev, enabled: action === "enable" } }, null, 2) + "\n",
      );
    });
  } else if (action === "run") {
    await runWorker(root, undefined, { once: true });
  }
  const status = await analysisStatus(io);
  return {
    ...status,
    text:
      action === "enable"
        ? "Фоновый анализ включён"
        : action === "disable"
          ? "Фоновый анализ выключен"
          : "Очередь анализа проверена",
  };
};

export const uiMaintenance = async (
  rootInput: string,
  action: "render" | "lint",
): Promise<{ text: string; lines: string[] }> => {
  const io = nodeIo(findRoot(rootInput), "antigravity");
  const config = await loadConfig(io);
  if (action === "render") {
    const r = await withLock(io, async () => renderAll(io, (await loadState(io)).entries, config));
    const lines = [...r.written.map((w) => `+ ${w}`), ...r.removed.map((w) => `- ${w}`)];
    return { text: lines.length ? `Перегенерировано файлов: ${lines.length}` : "Все файлы уже актуальны", lines };
  }
  const findings = await lint(io, (await loadState(io)).entries, config);
  const lines = findings.map((f) => `${f.level === "warn" ? "⚠" : "·"} ${f.text}`);
  return { text: lines.length ? `Находок lint: ${lines.length}` : "Замечаний lint нет", lines };
};

export const uiRegisterProject = async (rootInput: string, conversationId?: string): Promise<{ root: string }> => {
  const abs = resolve(rootInput.trim());
  if (!abs || !existsSync(abs)) throw new Error(`Папка не найдена: ${rootInput}`);
  const root = findRoot(abs);
  await registerWorkspace(root, conversationId);
  return { root };
};
