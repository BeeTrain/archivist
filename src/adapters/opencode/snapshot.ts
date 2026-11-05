import { createHash } from "node:crypto";
import { basename } from "node:path";
import { loadConfig } from "../../core/config.js";
import type { Io } from "../../core/io.js";
import { activeEntries, loadState } from "../../core/ledger.js";
import { applyProposals, listProposals, needsHuman, skipProposals, type Proposal } from "../../core/review.js";
import type { Entry } from "../../core/types.js";
import { tasks } from "./queue.js";
import type { UiSnapshot } from "./rpc.js";

const fingerprint = (proposal: Proposal) => createHash("sha256").update(JSON.stringify(proposal.op)).digest("hex");

const proposalView = (proposal: Proposal, entries: Map<string, Entry>): UiSnapshot["proposals"][number] => {
  const op = proposal.op;
  const existing = "id" in op ? entries.get(op.id) : undefined;
  const types = { command: "Команда", gotcha: "Ловушка", decision: "Решение", procedure: "Процедура" };
  const changes = { update: "Обновление записи", reinforce: "Подтверждение записи", deprecate: "Удаление из действующих знаний" };
  return {
    id: proposal.id, fingerprint: fingerprint(proposal), human: needsHuman(op),
    kind: op.op === "add" ? types[op.type] : changes[op.op],
    title: op.op === "add" ? op.title : op.op === "update" ? op.title ?? existing?.title ?? op.id : existing?.title ?? op.id,
    content: op.op === "add" ? op.content : op.op === "update" ? op.content ?? existing?.content ?? "" : op.op === "deprecate" ? op.reason : "Запись снова подтвердилась при работе над задачей.",
    ...(op.op === "add" && op.rationale ? { rationale: op.rationale } : {}),
    reason: proposal.reason?.replace(/^(?:codex|opencode|adapter): review required$/i, "Ожидает проверки").replaceAll("evidence file not found:", "Не найден подтверждающий файл:") ?? null,
  };
};

export const uiSnapshot = async (io: Io, sessionID: string, query = ""): Promise<UiSnapshot> => {
  const [state, proposals, pending, config] = await Promise.all([loadState(io), listProposals(io), tasks(io), loadConfig(io)]);
  const task = pending.find((task) => task.sessionID === sessionID);
  const all = activeEntries(state.entries).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  const search = query.toLocaleLowerCase();
  const entries = all.filter((entry) => !search || [entry.title, entry.content, entry.type, entry.id].some((text) => text.toLocaleLowerCase().includes(search)));
  const lastReport = task?.lastResult ?? pending.flatMap((task) => task.lastResult ? [task.lastResult] : []).sort((a, b) => b.at - a.at)[0] ?? null;
  return {
    project: basename(io.root), enabled: config.enabled, analysisEnabled: config.enabled && config.opencode.enabled,
    counts: { entries: all.length, review: proposals.length },
    entries: entries.slice(0, 500).map(({ id, type, title, content, rationale }) => ({ id, type, title, content, ...(rationale ? { rationale } : {}) })),
    matching: entries.length,
    proposals: proposals.map((proposal) => proposalView(proposal, state.entries)),
    analysis: { state: task?.state ?? "idle", message: task?.message ?? "Ожидание задачи", due: task?.due ?? null },
    result: task?.state === "done" && task.lastResult?.segment === task.segment.id ? task.lastResult : null,
    lastReport,
  };
};

export const uiReport = async (io: Io, sessionID: string): Promise<{ text: string }> => {
  const report = (await uiSnapshot(io, sessionID)).lastReport;
  if (!report || !/^\.archivist\/\.local\/reports\/[A-Za-z0-9-]+\.md$/.test(report.reportPath)) return { text: "Отчёт появится после первого анализа задачи." };
  return { text: ((await io.read(report.reportPath)) ?? "Отчёт больше недоступен.").slice(0, 100000) };
};

export const settleProposal = async (io: Io, input: { id: string; fingerprint: string; action: "apply" | "skip" }): Promise<{ text: string }> => {
  const proposal = (await listProposals(io)).find((proposal) => proposal.id === input.id);
  if (!proposal || fingerprint(proposal) !== input.fingerprint) throw new Error("Предложение изменилось или уже разобрано. Обновите очередь.");
  const now = new Date().toISOString();
  if (input.action === "skip") {
    const count = await skipProposals(io, [proposal], now);
    if (!count) throw new Error("Предложение уже разобрано. Обновите очередь.");
    return { text: "Предложение отклонено" };
  }
  const outcomes = await applyProposals(io, await loadConfig(io), [proposal], now);
  const applied = outcomes.find((outcome) => outcome.id);
  if (!applied) throw new Error(outcomes[0]?.reason ?? "Предложение не удалось применить. Обновите очередь.");
  return { text: "Предложение принято" };
};
