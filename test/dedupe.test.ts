// Duplicates the analyzer let through on this very project, kept as regression cases.
import { describe, expect, it } from "vitest";
import { CURATE_SYSTEM } from "../src/analyzer/prompts.js";
import type { ProposedOp } from "../src/core/types.js";
import { validateOps } from "../src/core/validate.js";
import { config, entry, memoryIo } from "./helpers.js";

const ts = "2026-10-22T10:00:00.000Z";

const retry = entry({
  id: "dec-cqft",
  type: "decision",
  title: "Повтор анализа через 15 минут, а не тихий выход",
  content: "При бюджете или лимите анализ повторяется через 15 минут. Вызов `fork` ограничен 120 с через `Promise.race` с `$.clock.sleep`.",
  rationale: "Тихий выход терял задачи.",
  adr: 3,
});
const devCopy = entry({
  id: "cmd-w5vd",
  type: "command",
  title: "Живая проверка правок мода через dev-копию",
  content: "После правок: `npm run check`, затем `rsync -a --delete plugin/ ~/.claude/dev-mods/<session>/archivist/`. Установленный из маркетплейса archivist на это время отключить, иначе мод загрузится дважды.",
});
const tests = entry({ id: "cmd-tnz2", type: "command", title: "Run tests", content: "`npm test` — runs `vitest run`" });

const run = (ops: ProposedOp[], docs: string[] = []) =>
  validateOps({ ops, entries: new Map([retry, devCopy, tests].map((e) => [e.id, e])), io: memoryIo(), config: config(), docs, now: ts });

describe("dedupe of paraphrased facts", () => {
  it("reinforces a decision restated in other words", async () => {
    const v = await run([{ op: "add", type: "decision", title: "Повтор при бюджете и таймаут fork", content: "При упоре в бюджет или лимит повторять через 15 минут. Таймаут `fork` — 120 с.", rationale: "Немедленный повтор бесполезен.", confidence: 0.9 }]);
    expect(v.applied).toMatchObject([{ id: "dec-cqft", reason: "duplicate of existing entry" }]);
  });

  it("reinforces a command fact restated as a gotcha", async () => {
    const v = await run([
      {
        op: "add",
        type: "gotcha",
        title: "npm run check не обновляет копию мода",
        content: "`npm run check` пересобирает `plugin/`, но не копирует его в `~/.claude/dev-mods/<session>/archivist/`. После проверки синхронизировать копию через `rsync`, иначе живой мод останется старым.",
        confidence: 0.9,
      },
    ]);
    expect(v.applied).toMatchObject([{ id: "cmd-w5vd", op: { op: "reinforce" } }]);
  });

  it("keeps two commands that run different things apart", async () => {
    const v = await run([{ op: "add", type: "command", title: "Run all checks", content: "`npm run check` — runs `npm run typecheck && npm test && npm run build`", confidence: 0.9 }]);
    expect(v.applied).toMatchObject([{ op: { op: "add" }, title: "Run all checks" }]);
  });

  it("drops a fact the README already states in other words", async () => {
    const readme = "| `archivist recall <слова>` | поиск по записям |\n| `archivist baseline [--before <дата>]` | метрики сессий Claude Code этого проекта до Archivist, из их транскриптов |\n| `archivist stats` | медианы последних задач против baseline |";
    const v = await run(
      [
        { op: "add", type: "command", title: "Разобрать транскрипты до Archivist: baseline", content: "Запустить `archivist baseline` в корне проекта: разбирает транскрипты Claude Code этого проекта за период до установки Archivist.", confidence: 0.9 },
        { op: "add", type: "gotcha", title: "Фильтровать транскрипт через jq", content: "Транскрипт фильтровать `jq` по полю `type`, а не `grep` по тексту: grep выводит в контекст целые сообщения.", confidence: 0.9 },
      ],
      [readme],
    );
    expect(v.rejected).toMatchObject([{ reason: "already in project docs" }]);
    expect(v.applied).toMatchObject([{ title: "Фильтровать транскрипт через jq" }]);
  });

  it("tells the curator to leave out temporary state and to-dos", () => {
    expect(CURATE_SYSTEM).toContain("Never record temporary state or to-dos");
  });
});
