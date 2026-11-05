import type { UiSnapshot } from "./rpc.js";

export const entryCount = (count: number): string => {
  const words: Record<string, string> = { one: "запись", few: "записи", other: "записей" };
  const word = words[new Intl.PluralRules("ru").select(count)] ?? "записей";
  return `${count} ${word}`;
};

export const analysisLabel = (snapshot: UiSnapshot): string => {
  if (!snapshot.enabled) return "Архивист выключен";
  if (!snapshot.analysisEnabled) return "Анализ выключен";
  if (snapshot.analysis.state === "analysing") return "Анализируется…";
  if (snapshot.analysis.state === "pending") return "Ожидание анализа";
  if (snapshot.analysis.state === "postponed") return "Анализ отложен";
  if (snapshot.analysis.state === "failed") return "Ошибка анализа";
  if (snapshot.result) return snapshot.result.proposed ? `Предложено: ${snapshot.result.proposed}` : "Новых знаний нет";
  return snapshot.analysis.state === "collecting" ? "Сбор контекста" : "Ожидание задачи";
};

export const pillLabel = (snapshot: UiSnapshot): string => {
  const counts = `${entryCount(snapshot.counts.entries)} · ${snapshot.counts.review} на ревью`;
  if (!snapshot.enabled || !snapshot.analysisEnabled) return `${counts} · Анализ выключен`;
  const active: Record<string, string> = { analysing: "Анализ…", pending: "Ожидание анализа", postponed: "Отложено", failed: "Ошибка анализа" };
  if (active[snapshot.analysis.state]) return `${active[snapshot.analysis.state]} · ${counts}`;
  return snapshot.result?.proposed ? `${counts} · +${snapshot.result.proposed}` : counts;
};

export const pillTone = (snapshot: UiSnapshot): "danger" | "warning" | "success" | undefined => {
  if (snapshot.analysisEnabled && snapshot.analysis.state === "failed") return "danger";
  if (snapshot.counts.review || snapshot.analysisEnabled && snapshot.analysis.state === "postponed") return "warning";
  return snapshot.result ? "success" : undefined;
};
