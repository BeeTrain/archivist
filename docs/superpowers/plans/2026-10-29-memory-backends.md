# Archivist 1.5.0: выбор памяти и mem0 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archivist кладёт записи в память, которую человек выбрал в настройках плагина. Это OpenViking, облако mem0 (только для явно включённых проектов) или свой сервер mem0.

**Architecture:**
- Ядро (`src/core`) получает общий интерфейс хранилища: текст в списке, дубли, отказы, частоту сверки.
- mem0 — два диалекта одного адаптера поверх транспорта `HttpCall`. Скоуп у обоих такой же, как у плагина mem0.
- Выбор памяти — чистая функция от настроек плагина. Мод только собирает её входы через `$` и строит хранилище.

**Tech Stack:** TypeScript (strict, ES2022), vitest, esbuild. Рантайм модов Claude Code (`$`), без Node в `src/core` и в моде.

**Spec:** `docs/superpowers/specs/2026-10-29-memory-backends-design.md`

## Global Constraints

**Ветка и рантайм**
- Ветка `feature/memory-projection`.
- `src/core` и мод собираются без Node; это проверяет `npm run typecheck` в обеих конфигурациях.
- В моде сеть идёт только через `$.http.fetch`, окружение — через `$.env.get("ИМЯ")` со строковым литералом. `$` передаётся только в функции верхнего уровня `register.ts`.

**Код и тесты**
- Код без комментариев, новых комментариев нет нигде.
- Тесты на vitest пишутся первыми, с подделками, без моков модулей. Пути в новых тестах — `/work/...`, не `/Users/...`.

**Безопасность**
- Ключ mem0 не появляется ни в логе, ни в тексте ошибки, ни в `/archivist memory`, ни в health.
- `MEM0_API_KEY` из окружения берётся только для облака.

**Настройки плагина и выбор памяти**
- Поля: `memory` (`auto` | `openviking` | `mem0` | `off`, по умолчанию `auto`), `memory_url`, `memory_api_key` (`sensitive`), `memory_cloud_projects`.
- Все поля необязательные, их тексты по-английски.
- `auto` никогда не выбирает mem0.
- Облако — это пустой адрес, хост `mem0.ai` или его поддомен. Любой другой адрес — свой сервер.
- В облако уходят только проекты из списка. Элемент списка — точный id, префикс с `/*` или `*`; регистр не важен.
- Сверка с хранилищем, чьи чтения тратят квоту, идёт не чаще раза в сутки на проект (`86_400_000` мс). Ручной `sync` сверяет всегда.

**Версия, проверки и коммиты**
- Версия 1.5.0.
- Перед каждым коммитом проходит `npm run check`. Коммит включает пересобранные `plugin/hooks/register.js` и `plugin/bin/archivist`.
- В сообщении коммита нет `Co-Authored-By` и строк «Generated with». Ничего не пушить.

## Review Focus

1. **Remote с заглавными буквами, учётными данными и `/` в конце** (`https://user:tok@GitHub.com/BeeTrain/Archivist/`). `agent_id` должен совпасть с тем, что вычисляет плагин mem0, иначе его recall не увидит записей. Тест — в задаче 5.
2. **Адрес с `/` в конце** (`http://localhost:8888/`). Запросы должны идти на `/memories`, а не на `//memories`. Тест — в задаче 6.
3. **Список проектов, набранный как попало:** пробелы, переводы строк, пустые элементы, заглавные (`GitHub.com/BeeTrain/*, ,`). Он должен разбираться, а сравнение — идти без учёта регистра. Тест — в задаче 8.
4. **Свой сервер без авторизации** (`AUTH_DISABLED=true`, ключа нет). Не должно уходить ни одного заголовка авторизации, и `MEM0_API_KEY` туда не попадает. Тесты — в задачах 6 и 8.
5. **mem0 отвечает не JSON** (HTML-страница прокси) **или повторяет ключ в ответе.** Нужна короткая понятная причина, а ключ — замаскирован. Тесты — в задаче 6.

## Решения, которые спецификация оставила строителю

**Поля и выбор**
- Поля называются `memory`, `memory_url`, `memory_api_key`, `memory_cloud_projects`.
- Список проектов — текст через запятую: такой `/config` точно даёт редактировать, а `$.config.set` — записать.
- Подсказка «уже показана» хранится в `$.store` по id проекта, поэтому показывается один раз на машину.

**Скоуп**
- Скоуп mem0 вычисляется в ядре (`src/core/mem0-scope.ts`), мод только собирает входы.
- `user_id` сначала берётся из настройки плагина mem0 (`$.config.list()`, строка `mem0….user_id`), затем из окружения, как у плагина mem0.
- `metadata.dirs` не заполняется: поиск плагина mem0 по папкам по умолчанию выключен.
- `GET /v1/ping/` не используется: отказ ключа виден по первому же запросу.

**Хранилище**
- Имя хранилища и кэша своего сервера — `mem0-<хост>-<порт>[-путь]`.
- Подпись `put` получает четвёртым параметром, ref `fetch` — вторым, `list()` возвращает `{ items, cut }`.

## Файлы

| Файл | Ответственность |
|---|---|
| `src/core/memory.ts` | интерфейс хранилища, сведение, дубли, режимы синхронизации, частота сверки, отказ и пауза |
| `src/core/mem0-scope.ts` (новый) | `app_id`, `agent_id`, `user_id` — как у плагина mem0 |
| `src/core/memory-mem0.ts` (новый) | транспорт HTTP, облачное хранилище, хранилище своего сервера, имя хранилища |
| `src/core/memory-choice.ts` (новый) | настройки плагина, выбор памяти, список облачных проектов, причины не синхронизировать |
| `src/core/memory-openviking.ts` | `list()` в новой форме |
| `src/core/maintenance.ts` | строки Memory в health |
| `src/core/config.ts` | без `memory.server` |
| `src/adapters/claude/mod/register.ts` | настройки плагина, цель синхронизации, режимы, `/archivist memory on\|off`, подсказка |
| `plugin/.claude-plugin/plugin.json` | `userConfig`, версия |
| `test/helpers.ts` | подделка хранилища |
| `test/memory*.test.ts`, `test/mem0-scope.test.ts`, `test/memory-choice.test.ts` | тесты |
| `README.md`, `docs/memory.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` | документация и версия |

## Перед началом

- [ ] Закоммитить проект и план:

```bash
git switch feature/memory-projection
git add docs/superpowers/specs/2026-10-29-memory-backends-design.md docs/superpowers/plans/2026-10-29-memory-backends.md
git commit -m "Design and plan for 1.5.0: memory choice and mem0"
```

---

### Task 1: Список с текстом, подпись в `put`

**Files:**
- Modify: `src/core/memory.ts` (`MemoryStore`, `MemoryCache`, `reconcile`, `clearMemory`)
- Modify: `src/core/memory-openviking.ts:54-62` (`list`)
- Modify: `src/core/maintenance.ts:118-124` (`memoryLines`)
- Modify: `test/helpers.ts:49-78` (`fakeMemoryStore`)
- Test: `test/memory.test.ts`, `test/memory-openviking.test.ts`, `test/memory-settings.test.ts`

**Interfaces:**
- Produces (в `src/core/memory.ts`):

```ts
export interface MemoryItem { ref: string; id: string; text?: string }
export interface MemoryListing { items: MemoryItem[]; cut?: boolean }
export interface MemoryStore {
  name: string;
  listsText?: boolean;
  put(id: string, text: string, ref: string | undefined, signature: Signature): Promise<string>;
  remove(ref: string): Promise<void>;
  fetch?(id: string, ref?: string): Promise<{ ref: string; text: string } | undefined>;
  list?(): Promise<MemoryListing>;
}
```

  `MemoryCache` получает поле `listCut?: boolean`.
- Produces (в `test/helpers.ts`): `fakeMemoryStore(project, seed = {}, options: { listsText?: boolean; cut?: boolean } = {})` возвращает `{ store, items, calls, failPut, refOf, signatures }`.
  - `signatures: Signature[]` — подписи, которые получил `put`.
  - id элемента разбирается из ref вида `fake://<project>/<id>.md` или `fake://<project>/<id>.md#<n>`: так тесты кладут дубли.
  - `list()` отдаёт текст, только если `listsText`, и `cut: true`, только если `cut`.

- [ ] **Step 1: Обновить подделку и написать падающие тесты**

В `test/memory.test.ts`, `describe("reconcile")`:

```ts
it("takes the text from a listing that carries it and reads no item one by one", async () => {
  const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project) }, { listsText: true });
  const { outcome } = await sync(fake, ledger(gotcha, command), emptyCache(), new Set(), true);
  expect(outcome.adopted).toEqual(["gk-1"]);
  expect(outcome.written).toEqual(["cmd-1"]);
  expect(fake.calls).toEqual(["list", "put cmd-1"]);
});

it("hands the store the entry's signature with the text", async () => {
  const fake = fakeMemoryStore(project);
  await sync(fake, ledger(gotcha));
  expect(fake.signatures).toEqual([{ project, id: "gk-1", updated: ts }]);
});

it("notes when memory listed as many items as it gives at once", async () => {
  const fake = fakeMemoryStore(project, {}, { cut: true });
  const { cache } = await sync(fake, ledger(gotcha), emptyCache(), new Set(), true);
  expect(cache.listCut).toBe(true);
});
```

В `describe("syncMemory")`:

```ts
it("clears from the listing alone when it carries the text", async () => {
  const io = await withLedger(gotcha);
  const fake = fakeMemoryStore(project, {}, { listsText: true });
  await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
  fake.calls.length = 0;
  expect(await clearMemory(io, fake.store, project)).toEqual(["gk-1"]);
  expect(fake.calls).toEqual(["list", `remove ${fake.refOf("gk-1")}`]);
});
```

В `test/memory-openviking.test.ts`:
- `store.put(...)` вызывается с `undefined` и подписью `{ project, id: "gk-1", updated: "2026-10-23T10:00:00.000Z" }`;
- ожидания `list()` становятся `{ items: [...] }` и `{ items: [] }`.

В `test/memory-settings.test.ts`, `describe("health of the memory projection")` — кэш с `listCut: true`:

```ts
expect(memory).toContain("memory listed as many items as it gives at once: the counts above may be short");
```

- [ ] **Step 2: Запустить и убедиться, что новые тесты падают**

Run: `npx vitest run test/memory.test.ts test/memory-openviking.test.ts test/memory-settings.test.ts`
Expected: FAIL в новых тестах и в изменённых ожиданиях OpenViking.

- [ ] **Step 3: Реализовать**

**`reconcile`**
- В режиме сверки берёт `listing = await store.list()`.
- Считает список полным, если `store.listsText && !listing.cut`.
- Для изменённой записи:

  ```ts
  const listed = present?.get(e.id);
  const remote = listed?.text !== undefined ? { ref: listed.ref, text: listed.text } : known ? undefined : await store.fetch?.(e.id, sent?.ref ?? listed?.ref);
  ```

- `put` получает `{ project: cache.project, id: e.id, updated: e.updated }`.
- В кэш при сверке пишется `listCut: listing.cut`.

**`clearMemory`** берёт текст из `item.text`, а `fetch` вызывает, только когда текста нет.

**OpenViking** — `list()` возвращает `{ items }`.

**`memoryLines`** — строка из теста при `listCut`.

- [ ] **Step 4: Запустить тесты и типы**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, без ошибок типов.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "Memory listing carries text; put gets the entry's signature"
```

---

### Task 2: Дубли одной записи

**Files:**
- Modify: `src/core/memory.ts` (`SyncOutcome`, `reconcile`, `memoryOutcomeText`)
- Test: `test/memory.test.ts`

**Interfaces:**
- Consumes: `MemoryItem`, `MemoryListing`, `listsText` из задачи 1.
- Produces: `SyncOutcome.duplicates: string[]` — id записи по одному разу на каждую удалённую лишнюю копию. `memoryOutcomeText` пишет `N duplicates removed`.

- [ ] **Step 1: Написать падающие тесты**

В `test/memory.test.ts` добавить импорт `memoryOutcomeText`. В задаче 3 туда же добавится `memoryCachePath`.

```ts
it("keeps the copy that matches the ledger and removes the other copies", async () => {
  const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project) }, { listsText: true });
  fake.items.set(`${fake.refOf("gk-1")}#2`, renderItem(gotcha, project));
  fake.items.set(`${fake.refOf("gk-1")}#3`, renderItem({ ...gotcha, content: "An older wording", updated: "2026-10-22T10:00:00.000Z" }, project));
  const { cache, outcome } = await sync(fake, ledger(gotcha), emptyCache(), new Set(), true);
  expect(outcome.duplicates).toEqual(["gk-1", "gk-1"]);
  expect([...fake.items.keys()]).toEqual([fake.refOf("gk-1")]);
  expect(cache.items["gk-1"]?.ref).toBe(fake.refOf("gk-1"));
  expect(memoryOutcomeText(outcome)).toContain("2 duplicates removed");
});

it("keeps the newest copy when none matches the ledger", async () => {
  const newer = renderItem({ ...gotcha, content: "Ahead in another clone", updated: later }, project);
  const fake = fakeMemoryStore(project, { "gk-1": renderItem({ ...gotcha, content: "Old", updated: "2026-10-22T10:00:00.000Z" }, project) }, { listsText: true });
  fake.items.set(`${fake.refOf("gk-1")}#2`, newer);
  const { outcome } = await sync(fake, ledger(gotcha), emptyCache(), new Set(), true);
  expect(outcome.duplicates).toEqual(["gk-1"]);
  expect(outcome.newer).toEqual(["gk-1"]);
  expect([...fake.items.values()]).toEqual([newer]);
});

it("removes every copy of a retired entry", async () => {
  const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project) }, { listsText: true });
  fake.items.set(`${fake.refOf("gk-1")}#2`, renderItem(gotcha, project));
  const { outcome } = await sync(fake, ledger({ ...gotcha, status: "deprecated", updated: later }), emptyCache(), new Set(), true);
  expect(outcome.removed).toEqual(["gk-1"]);
  expect(fake.items.size).toBe(0);
});

it("leaves copies alone when the listing has no text to choose by", async () => {
  const fake = fakeMemoryStore(project, { "gk-1": renderItem(gotcha, project) });
  fake.items.set(`${fake.refOf("gk-1")}#2`, renderItem(gotcha, project));
  const { outcome } = await sync(fake, ledger(gotcha), emptyCache(), new Set(), true);
  expect(outcome.duplicates).toEqual([]);
  expect(fake.items.size).toBe(2);
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/memory.test.ts`
Expected: FAIL: `outcome.duplicates` равен `undefined`.

- [ ] **Step 3: Реализовать**

Копии записи группируются по id: `Map<string, MemoryItem[]>`.

**Выведенная запись.** Удаляются все копии, а также `sent.ref`. В `removed` id попадает один раз.

**Действующая запись.** Правило работает, только если запись не stale, копий больше одной и у каждой есть текст. Остаётся одна копия:

```ts
const keeperOf = (copies: MemoryItem[], text: string): MemoryItem =>
  copies.find((c) => c.text!.trimEnd() === text.trimEnd()) ??
  copies.reduce((a, b) => ((readSignature(b.text!)?.updated ?? "") > (readSignature(a.text!)?.updated ?? "") ? b : a));
```

Остальные копии удаляются. Дальше сведение идёт с оставшейся копией. Неизвестные журналу id не трогаются.

- [ ] **Step 4: Запустить**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "Memory sync removes duplicate copies of an entry"
```

---

### Task 3: Режимы синхронизации и сверка раз в сутки

**Files:**
- Modify: `src/core/memory.ts` (`MemoryStore.readsCostQuota`, `MemoryCache.lastVerify`, `syncMemory`, `memoryUpToDate`)
- Modify: `src/core/maintenance.ts:111-114,181-182` (`HealthExtras.memoryNote`)
- Modify: `src/adapters/claude/mod/register.ts:87,230-253,266,401` — только места вызова
- Modify: `test/helpers.ts` (опция `readsCostQuota`)
- Test: `test/memory.test.ts`, `test/memory-settings.test.ts`

**Interfaces:**
- Produces:
  - `export type SyncMode = "fast" | "start" | "full"`;
  - `export const VERIFY_INTERVAL_MS = 86_400_000`;
  - `syncMemory({ io, store, project, mode: SyncMode, now })`;
  - `memoryUpToDate(io: Io, store: string): Promise<boolean>`;
  - `MemoryStore.readsCostQuota?: boolean`;
  - `HealthExtras.memoryNote?: string`.

  Правила по режимам:

  | Режим | Когда сверяет | Когда пропускает |
  |---|---|---|
  | `fast` | только при первой синхронизации | журнал тот же и ошибки нет |
  | `start` | всегда; у хранилища с `readsCostQuota` — только если с `lastVerify` прошло не меньше `VERIFY_INTERVAL_MS` | без сверки: журнал тот же и ошибки нет |
  | `full` | всегда | никогда |

  - Первая синхронизация сверяет в любом режиме.
  - После сверки `lastVerify = now`.

- [ ] **Step 1: Написать падающие тесты**

В `describe("syncMemory")`:

```ts
it("checks memory at every session start when reading it is free", async () => {
  const io = await withLedger(gotcha);
  const fake = fakeMemoryStore(project);
  await syncMemory({ io, store: fake.store, project, mode: "start", now: ts });
  fake.calls.length = 0;
  await syncMemory({ io, store: fake.store, project, mode: "start", now: later });
  expect(fake.calls).toContain("list");
});

it("checks memory whose reads cost quota at most once a day, unless asked by hand", async () => {
  const io = await withLedger(gotcha);
  const fake = fakeMemoryStore(project, {}, { readsCostQuota: true });
  await syncMemory({ io, store: fake.store, project, mode: "start", now: "2026-10-23T10:00:00.000Z" });
  fake.calls.length = 0;
  await syncMemory({ io, store: fake.store, project, mode: "start", now: "2026-10-23T20:00:00.000Z" });
  expect(fake.calls).toEqual([]);
  await syncMemory({ io, store: fake.store, project, mode: "full", now: "2026-10-23T21:00:00.000Z" });
  expect(fake.calls).toContain("list");
  fake.calls.length = 0;
  await syncMemory({ io, store: fake.store, project, mode: "start", now: "2026-10-24T22:00:00.000Z" });
  expect(fake.calls).toContain("list");
});

it("tells whether memory is up to date from the store in use only", async () => {
  const io = await withLedger(gotcha);
  io.files.set(memoryCachePath("old"), JSON.stringify({ store: "old", project, items: {}, ledgerMark: "stale" }));
  const fake = fakeMemoryStore(project);
  await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts });
  expect(await memoryUpToDate(io, "fake")).toBe(true);
  expect(await memoryUpToDate(io, "old")).toBe(false);
});
```

В тесте «knows memory is up to date…» вызов меняется на `memoryUpToDate(io, "fake")`.

В `test/memory-settings.test.ts`:

```ts
it("shows the mod's note about memory even before anything was sent", async () => {
  const io = memoryIo();
  await appendLedger(io, [add(entry({ id: "gk-1", type: "gotcha", title: "Alpha", content: "A fact", created: day(1) }))]);
  const note = "mem0 cloud is chosen, but github.com/beetrain/archivist is not sent there: /archivist memory on sends it.";
  const text = await healthText(io, (await loadState(io)).entries, config(), now, { memoryNote: note });
  expect(text.split("## Memory\n")[1]).toContain(note);
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/memory.test.ts test/memory-settings.test.ts`
Expected: FAIL в новых тестах.

- [ ] **Step 3: Реализовать**

**Ядро**
- `syncMemory` работает по таблице режимов.
- `memoryUpToDate` смотрит только на кэш хранилища `store`.

**Health**
- `healthText` выводит раздел `## Memory`, если есть `memoryNote` или кэши.
- Заметка идёт первой строкой: `- <memoryNote>`.

**Мод — только места вызова**
- `session.start` вызывает `'start'`.
- `memory sync` вызывает `'full'`.
- `memoryUpToDate(io, 'openviking')` — до задачи 9.
- `memoryAgain: SyncMode | undefined` берёт более сильный режим: `full > start > fast`.

- [ ] **Step 4: Запустить**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "Memory sync modes: check memory whose reads cost quota once a day"
```

---

### Task 4: Отказ останавливает прогон и ставит паузу

**Files:**
- Modify: `src/core/memory.ts` (`MemoryRefused`, `SyncOutcome.refused`, `MemoryCache.paused`, `reconcile`, `syncMemory`, `memoryOutcomeText`)
- Modify: `src/core/maintenance.ts` (`memoryLines`)
- Modify: `test/helpers.ts` (`refusePut: Set<string>`: `put` такого id бросает `new MemoryRefused("mem0 refused the request (HTTP 401): Invalid API key")`)
- Test: `test/memory.test.ts`, `test/memory-settings.test.ts`

**Interfaces:**
- Produces:
  - `export class MemoryRefused extends Error {}`;
  - `SyncOutcome.refused?: string`;
  - `MemoryCache.paused?: string`.

  Поведение:
  - Отказ из `list` или из операции с записью останавливает `reconcile`: что уже записано, остаётся в кэше.
  - `syncMemory` после отказа сохраняет `paused` и `lastError` с текстом отказа.
  - Пока стоит `paused`, режим `fast` возвращает `undefined` и ничего не вызывает. Режимы `start` и `full` пробуют снова, и успех снимает паузу.
  - `memoryOutcomeText` добавляет `; stopped: <refused>`.

- [ ] **Step 1: Написать падающие тесты**

```ts
it("stops at a refusal, keeps what it sent before it, and says why", async () => {
  const fake = fakeMemoryStore(project);
  fake.refusePut.add("cmd-1");
  const procedure = entry({ id: "proc-1", type: "procedure", title: "Release", content: "1. npm run check", created: ts, updated: ts });
  const { cache, outcome } = await sync(fake, ledger(gotcha, command, procedure));
  expect(outcome.written).toEqual(["gk-1"]);
  expect(outcome.refused).toBe("mem0 refused the request (HTTP 401): Invalid API key");
  expect(fake.calls).not.toContain("fetch proc-1");
  expect(cache.items["gk-1"]).toBeDefined();
  expect(memoryOutcomeText(outcome)).toContain("stopped: mem0 refused the request (HTTP 401)");
});

it("pauses after a refusal until the next session start or a sync by hand", async () => {
  const io = await withLedger(gotcha);
  const fake = fakeMemoryStore(project);
  fake.refusePut.add("gk-1");
  expect((await syncMemory({ io, store: fake.store, project, mode: "fast", now: ts }))?.refused).toBeDefined();
  fake.calls.length = 0;
  await appendLedger(io, [{ v: 1, ts: later, op: "add", entry: command }]);
  expect(await syncMemory({ io, store: fake.store, project, mode: "fast", now: later })).toBeUndefined();
  expect(fake.calls).toEqual([]);
  fake.refusePut.clear();
  expect((await syncMemory({ io, store: fake.store, project, mode: "start", now: later }))?.written.sort()).toEqual(["cmd-1", "gk-1"]);
  expect((await loadMemoryCache(io, "fake", project)).paused).toBeUndefined();
});
```

В `test/memory-settings.test.ts` — кэш с `paused` и `lastError`, равными `"mem0 refused the request (HTTP 401): Invalid API key"`:

```ts
expect(memory).toContain("paused until the next session or /archivist memory sync: mem0 refused the request (HTTP 401)");
expect(memory).not.toContain("last error:");
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/memory.test.ts test/memory-settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализовать**

- В `reconcile` блок `catch` записи на `MemoryRefused` ставит `outcome.refused` и выходит из цикла. Отказ из `list` ловится так же.
- В `memoryLines` строка паузы заменяет строку `last error`.

- [ ] **Step 4: Запустить**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "A refused key or quota stops memory sync until the next session"
```

---

### Task 5: Скоуп mem0 как у плагина mem0

**Files:**
- Create: `src/core/mem0-scope.ts`
- Test: `test/mem0-scope.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Mem0Scope { appId: string; agentId: string; userId: string }
export const normalizeRemote = (remote: string): string;
export const mem0Scope = (args: { rawRemote: string | undefined; root: string; projectIdEnv: string | undefined; userIdCandidates: readonly (string | undefined)[] }): Promise<Mem0Scope>;
```

  `rawRemote` — вывод `git config --get remote.origin.url`, как у плагина mem0.

- [ ] **Step 1: Написать падающие тесты**

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mem0Scope, normalizeRemote } from "../src/core/mem0-scope.js";

const hash10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const scope = (rawRemote: string | undefined, over: { projectIdEnv?: string; userIdCandidates?: (string | undefined)[] } = {}) =>
  mem0Scope({ rawRemote, root: "/work/my-app", projectIdEnv: over.projectIdEnv, userIdCandidates: over.userIdCandidates ?? [] });

const remotes: [string, string, string][] = [
  ["git@github.com:BeeTrain/archivist.git", "BeeTrain-archivist", "https://github.com/BeeTrain/archivist"],
  ["https://user:tok@GitHub.com/BeeTrain/Archivist/", "BeeTrain-Archivist", "https://github.com/BeeTrain/Archivist"],
  ["ssh://git@git.example.com:2222/team/app.git", "team-app", "ssh://git.example.com:2222/team/app"],
];

describe("the mem0 scope", () => {
  it.each(remotes)("normalizes %s the way the mem0 plugin does", (raw, _appId, identity) => {
    expect(normalizeRemote(raw)).toBe(identity);
  });

  it.each(remotes)("gives %s the mem0 plugin's app_id and agent_id", async (raw, appId, identity) => {
    expect(await scope(raw)).toMatchObject({ appId, agentId: `${appId}-${hash10(identity)}` });
  });

  it("names a folder without a remote by its path", async () => {
    expect(await scope(undefined)).toMatchObject({ appId: "my-app", agentId: `local-my-app-${hash10("/work/my-app")}` });
  });

  it("takes MEM0_PROJECT_ID as the app_id, but not a wildcard", async () => {
    expect((await scope(remotes[0]![0], { projectIdEnv: "shared-app" })).agentId).toBe(`shared-app-${hash10(remotes[0]![2])}`);
    expect((await scope(remotes[0]![0], { projectIdEnv: "**" })).appId).toBe("BeeTrain-archivist");
  });

  it("takes the first user id that is set and is not a wildcard, else default", async () => {
    expect((await scope(undefined, { userIdCandidates: [undefined, " ", "*", "dev-user", "other"] })).userId).toBe("dev-user");
    expect((await scope(undefined)).userId).toBe("default");
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/mem0-scope.test.ts`
Expected: FAIL: модуля нет.

- [ ] **Step 3: Реализовать `src/core/mem0-scope.ts`**

Это перенос `_normalize_remote`, `_legacy_project_id` (без `~/.mem0/project_map.json`), `_project_id` и `user_id` из `integrations/claude-code-plugin/core/memory_core.py` репозитория mem0. Поведение должно совпадать до символа:

```ts
export const normalizeRemote = (remote: string): string => {
  let r = remote.trim();
  if (r.startsWith("git@") && r.includes(":")) r = `https://${r.slice(4).replace(":", "/")}`;
  if (r.endsWith(".git")) r = r.slice(0, -4);
  const url = r.match(/^([^:/?#]+):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (url) {
    const [, scheme, netloc, path, query = "", fragment = ""] = url;
    const [, host = "", port] = netloc!.slice(netloc!.lastIndexOf("@") + 1).match(/^(.*?)(?::(\d+))?$/)!;
    r = `${scheme!.toLowerCase()}://${host.toLowerCase()}${port ? `:${Number(port)}` : ""}${path}${query.length > 1 ? query : ""}${fragment.length > 1 ? fragment : ""}`;
  }
  return r.replace(/\/+$/, "");
};

const scopeValue = (raw: string | undefined): string => {
  const value = (raw ?? "").trim();
  return /^\*+$/.test(value) ? "" : value;
};

const appIdOf = (rawRemote: string, identity: string, root: string, configured: string | undefined): string => {
  const fixed = scopeValue(configured);
  if (fixed) return fixed;
  let remote = (rawRemote || (identity.startsWith("local:") ? "" : identity)).trim();
  if (remote.endsWith(".git")) remote = remote.slice(0, -4);
  const prefix = ["https://", "http://", "ssh://", "git://"].find((p) => remote.startsWith(p));
  remote = prefix ? remote.slice(prefix.length) : remote.replace(/^git@/, "");
  const parts = remote.replace(":", "/").split("/").filter(Boolean);
  const name = parts.length >= 2 ? `${parts.at(-2)}-${parts.at(-1)}` : parts.at(-1);
  return name ? name.replaceAll("/", "-").replaceAll(":", "-") : root.split("/").filter(Boolean).at(-1) || "unknown";
};
```

**`agent_id`**
- Сначала `identity = normalizeRemote(rawRemote ?? "") || `local:${root}``.
- Без remote: `local-${appId}-${hash10(root)}`.
- С remote: `${appId}-${hash10(identity)}`.

**Хэш** считается через `crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))`, это первые 10 hex-символов. Так работает и в рантайме модов, и в Node.

**`userId`** — первый непустой `scopeValue` из кандидатов, иначе `"default"`.

- [ ] **Step 4: Запустить**

Run: `npx vitest run test/mem0-scope.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "mem0 scope computed the way the mem0 plugins compute it"
```

---

### Task 6: Транспорт HTTP и облачное хранилище mem0

**Files:**
- Create: `src/core/memory-mem0.ts`
- Test: `test/memory-mem0.test.ts`

**Interfaces:**
- Consumes:
  - `MemoryStore`, `MemoryListing`, `MemoryRefused`, `Signature`, `readSignature` из `memory.ts`;
  - `Mem0Scope` из задачи 5.
- Produces:

```ts
export interface HttpReply { status: number; text: string }
export type HttpCall = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<HttpReply>;
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpReply>;
export interface Mem0Auth { header: string; value: string; secret: string }
export const MEM0_CLOUD_URL = "https://api.mem0.ai";
export const isMem0Cloud = (address: string): boolean;
export const mem0StoreName = (address: string): string;
export const mem0Transport = (fetcher: Fetcher, base: string, auth: Mem0Auth | undefined): HttpCall;
export const mem0CloudStore = (http: HttpCall, scope: Mem0Scope, project: string): MemoryStore;
```

- [ ] **Step 1: Написать падающие тесты**

```ts
import { describe, expect, it } from "vitest";
import type { Mem0Scope } from "../src/core/mem0-scope.js";
import { MemoryRefused } from "../src/core/memory.js";
import { isMem0Cloud, MEM0_CLOUD_URL, mem0CloudStore, mem0StoreName, mem0Transport, type Fetcher, type HttpCall, type HttpReply } from "../src/core/memory-mem0.js";

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
    const fetcher: Fetcher = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8888"); };
    await expect(mem0Transport(fetcher, "http://localhost:8888/", undefined)("GET", "/memories")).rejects.toThrow("mem0 at http://localhost:8888 is unreachable: connect ECONNREFUSED");
  });

  it.each<[string, boolean]>([["", true], ["https://api.mem0.ai", true], ["https://eu.api.mem0.ai/", true], ["http://localhost:8888", false], ["https://mem0.ai.example.com", false]])(
    "takes %j for the cloud: %s", (address, cloud) => expect(isMem0Cloud(address)).toBe(cloud));

  it.each([["", "mem0"], ["https://api.mem0.ai", "mem0"], ["http://localhost:8888", "mem0-localhost-8888"], ["https://mem0.corp.example/api/", "mem0-mem0.corp.example-api"]])(
    "names the store for %j %s", (address, name) => expect(mem0StoreName(address)).toBe(name));
});

describe("the mem0 cloud store", () => {
  it("adds an entry verbatim with the plugin's scope and the signature in flat metadata", async () => {
    const { calls, http } = fakeHttp([json(200, { status: "SUCCEEDED", results: [{ id: "uuid-1", event: "ADD" }] })]);
    expect(await mem0CloudStore(http, scope, project).put("gk-1", "# Title\n", undefined, signature)).toBe("uuid-1");
    expect(calls).toEqual([{ method: "POST", path: "/v3/memories/add/", body: {
      messages: [{ role: "user", content: "# Title\n" }], infer: false, immutable: true,
      app_id: "BeeTrain-archivist", agent_id: "BeeTrain-archivist-0123456789", user_id: "dev-user", metadata,
    } }]);
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
    expect(await mem0CloudStore(http, scope, project).list!()).toEqual({ items: [{ ref: "uuid-1", id: "gk-1", text: "# gk-1\n" }, { ref: "uuid-2", id: "cmd-1", text: "# cmd-1\n" }] });
    expect(calls[0]).toEqual({ method: "POST", path: "/v3/memories/?page=1&page_size=200", body: {
      filters: { AND: [{ app_id: "BeeTrain-archivist" }, { metadata: { archivist_project: project } }] }, fields: ["id", "memory", "metadata", "updated_at"],
    } });
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

  it("gives a short reason when mem0 answers with something that is not JSON", async () => {
    const error = await mem0CloudStore(fakeHttp([{ status: 502, text: `<html>${"x".repeat(5000)}</html>` }]).http, scope, project).remove("uuid-1").catch((e: unknown) => e);
    expect(String(error)).toContain("HTTP 502");
    expect(String(error).length).toBeLessThan(300);
  });

  it("says its reads cost quota and its listing carries the text", () => {
    expect(mem0CloudStore(fakeHttp([]).http, scope, project)).toMatchObject({ name: "mem0", readsCostQuota: true, listsText: true });
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/memory-mem0.test.ts`
Expected: FAIL: модуля нет.

- [ ] **Step 3: Реализовать `src/core/memory-mem0.ts`**

**Транспорт**
- Адрес — это `base` без `/` в конце плюс `path`.
- Тело запроса — `JSON.stringify(body)`. Поля `body` нет, если тела нет.
- В тексте ответа каждое вхождение `auth.secret` заменяется на `***`.
- Если `fetcher` бросает ошибку, транспорт бросает `mem0 at <base> is unreachable: <message>`.

**Разбор ответа**, общий для двух хранилищ.
- Причина берётся из `detail`, `message` или `error` в JSON, иначе из сырого текста. Пробелы схлопываются, длина — не больше 200 символов.
- Статусы 401, 402, 403 и 429 дают `MemoryRefused("mem0 refused the request (HTTP <s>): <причина>")`.
- Другой статус не из 2xx даёт `Error("mem0 request failed (HTTP <s>): <причина>")`.

**Metadata** — `archivist_key`, `archivist_project`, `archivist_id`, `archivist_updated` из подписи.

**Облачное хранилище**
- id нового элемента — это `results[0].id`. Если его нет, ошибка `mem0 stored nothing`.
- При изменении ошибка удаления старой версии глушится. Исключение — `MemoryRefused`: он пробрасывается.
- В списке элементы без `metadata.archivist_id` пропускаются, страницы идут, пока `next` не пуст.
- `fetch` берёт новейшую копию по `readSignature`.

**Имя хранилища**
- Облако — `mem0`.
- Свой сервер — `mem0-` плюс хост, порт и путь. Всё, кроме `[a-z0-9._-]`, превращается в `-`, крайние `-` срезаются.

- [ ] **Step 4: Запустить**

Run: `npx vitest run test/memory-mem0.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "mem0 cloud store over its REST API"
```

---

### Task 7: Хранилище своего сервера mem0

**Files:**
- Modify: `src/core/memory-mem0.ts`
- Test: `test/memory-mem0.test.ts`

**Interfaces:**
- Consumes: всё из задачи 6.
- Produces: `export const mem0ServerStore = (http: HttpCall, scope: Mem0Scope, project: string, name: string): MemoryStore`, у которого `readsCostQuota: false`, `listsText: true`.

- [ ] **Step 1: Написать падающие тесты**

```ts
describe("the store on an own mem0 server", () => {
  const store = (http: HttpCall) => mem0ServerStore(http, scope, project, "mem0-localhost-8888");

  it("adds an entry verbatim with the scope, without app_id", async () => {
    const { calls, http } = fakeHttp([json(200, { results: [{ id: "m-1", event: "ADD" }] })]);
    expect(await store(http).put("gk-1", "# Title\n", undefined, signature)).toBe("m-1");
    expect(calls).toEqual([{ method: "POST", path: "/memories", body: {
      messages: [{ role: "user", content: "# Title\n" }], infer: false, agent_id: scope.agentId, user_id: "dev-user", metadata,
    } }]);
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
    const { calls, http } = fakeHttp([json(200, { results: [
      { id: "m-1", memory: "# gk-1\n", metadata },
      { id: "m-9", memory: "another project", metadata: { ...metadata, archivist_project: "github.com/someone/else" } },
      { id: "m-8", memory: "not Archivist's", metadata: {} },
    ] })]);
    expect(await store(http).list!()).toEqual({ items: [{ ref: "m-1", id: "gk-1", text: "# gk-1\n" }], cut: false });
    expect(calls[0]).toEqual({ method: "GET", path: `/memories?agent_id=${encodeURIComponent(scope.agentId)}&top_k=1000` });
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

  it("counts deleting an item that is gone as done", async () => {
    const { calls, http } = fakeHttp([json(404, { detail: "Memory with id m-1 not found" })]);
    await expect(store(http).remove("m-1")).resolves.toBeUndefined();
    expect(calls[0]).toEqual({ method: "DELETE", path: "/memories/m-1" });
  });

  it("reads for free and carries the text in its listing", () => {
    expect(store(fakeHttp([]).http)).toMatchObject({ name: "mem0-localhost-8888", readsCostQuota: false, listsText: true });
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/memory-mem0.test.ts`
Expected: FAIL: `mem0ServerStore` не экспортирован.

- [ ] **Step 3: Реализовать `mem0ServerStore`**

- Тело списка бывает `{ results }` или голым массивом — подходят оба.
- `cut` равен `true`, если сервер отдал 1000 строк. Это число считается до фильтра по проекту.
- `fetch(id, ref)` с `ref` делает `GET /memories/{ref}`. Ответ подходит, если `metadata.archivist_key` совпадает. Иначе, в том числе при ответе `null`, ищется копия в списке и берётся новейшая.
- id в пути проходит через `encodeURIComponent`.

- [ ] **Step 4: Запустить**

Run: `npx vitest run test/memory-mem0.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "Store for an own mem0 server: change in place, one listing"
```

---

### Task 8: Выбор памяти по настройкам плагина

**Files:**
- Create: `src/core/memory-choice.ts`
- Test: `test/memory-choice.test.ts`

**Interfaces:**
- Consumes:
  - `isMem0Cloud`, `MEM0_CLOUD_URL`, `mem0StoreName` из задачи 6;
  - `Config` из `config.ts`.
- Produces:

```ts
export type MemoryKind = "auto" | "openviking" | "mem0" | "off";
export interface MemoryOptions { memory: MemoryKind; url: string; apiKey: string; cloudProjects: string[] }
export const CLOUD_PROJECTS_OPTION = "memory_cloud_projects";
export const readMemoryOptions = (options: Readonly<Record<string, unknown>>): MemoryOptions;
export const cloudAllowedBy = (project: string, entries: readonly string[]): string | undefined;
export const withCloudProject = (entries: readonly string[], project: string): string[];
export const withoutCloudProject = (entries: readonly string[], project: string): string[];
export type MemoryChoice =
  | { kind: "none"; why: string }
  | { kind: "openviking"; server: string }
  | { kind: "mem0"; base: string; cloud: boolean; key: string | undefined; allowed: boolean };
export const chooseMemory = (args: { options: MemoryOptions; project: string; envKey: string | undefined; openVikingServer: string | undefined }): MemoryChoice;
export const memoryWhere = (choice: MemoryChoice): string;
export const storeNameFor = (options: MemoryOptions): string | undefined;
export const memorySyncBlock = (config: Config, choice: MemoryChoice, project: string): string | undefined;
```

- [ ] **Step 1: Написать падающие тесты**

```ts
import { describe, expect, it } from "vitest";
import { chooseMemory, cloudAllowedBy, memorySyncBlock, memoryWhere, readMemoryOptions, storeNameFor, withCloudProject, withoutCloudProject, type MemoryOptions } from "../src/core/memory-choice.js";
import { config } from "./helpers.js";

const project = "github.com/beetrain/archivist";
const ov = "plugin:openviking-memory:openviking";
const options = (over: Partial<MemoryOptions> = {}): MemoryOptions => ({ memory: "auto", url: "", apiKey: "", cloudProjects: [], ...over });
const choose = (over: Partial<MemoryOptions>, more: { envKey?: string; openVikingServer?: string } = {}) =>
  chooseMemory({ options: options(over), project, envKey: more.envKey, openVikingServer: more.openVikingServer });

describe("the plugin options", () => {
  it("reads what /config stores and fills the gaps with defaults", () => {
    expect(readMemoryOptions({ memory: "mem0", memory_url: " http://localhost:8888 ", memory_api_key: " k-1 ", memory_cloud_projects: "GitHub.com/BeeTrain/*, ,github.com/a/b,\n" }))
      .toEqual({ memory: "mem0", url: "http://localhost:8888", apiKey: "k-1", cloudProjects: ["GitHub.com/BeeTrain/*", "github.com/a/b"] });
    expect(readMemoryOptions({ memory: "something else" })).toEqual(options());
  });
});

describe("projects sent to cloud memory", () => {
  it.each<[string, string | undefined]>([
    [project, project],
    ["GitHub.com/BeeTrain/*", "GitHub.com/BeeTrain/*"],
    ["*", "*"],
    ["github.com/beetrain/archivist-docs", undefined],
    ["github.com/beetrain", undefined],
  ])("entry %s lets the project through: %s", (entry, by) => expect(cloudAllowedBy(project, [entry])).toBe(by));

  it("adds this project once and removes only its own entry", () => {
    expect(withCloudProject(["github.com/a/*"], project)).toEqual(["github.com/a/*", project]);
    expect(withCloudProject([project.toUpperCase()], project)).toEqual([project.toUpperCase()]);
    expect(withoutCloudProject(["github.com/beetrain/*", "GitHub.com/BeeTrain/Archivist"], project)).toEqual(["github.com/beetrain/*"]);
  });
});

describe("choosing the memory", () => {
  it("keeps entries in files only when memory is off, even with OpenViking connected", () => {
    expect(choose({ memory: "off" }, { openVikingServer: ov })).toMatchObject({ kind: "none" });
  });

  it("finds OpenViking on auto and never picks mem0 there, even with MEM0_API_KEY set", () => {
    expect(choose({}, { openVikingServer: ov, envKey: "k-env" })).toEqual({ kind: "openviking", server: ov });
    expect(choose({}, { envKey: "k-env" })).toMatchObject({ kind: "none" });
  });

  it("says OpenViking is not connected when it is chosen and missing", () => {
    expect(choose({ memory: "openviking" })).toEqual({ kind: "none", why: expect.stringContaining("not connected") });
  });

  it("takes the mem0 cloud for an empty address, with the key from the options or else MEM0_API_KEY", () => {
    expect(choose({ memory: "mem0", apiKey: "k-1", cloudProjects: [project] }, { envKey: "k-env" })).toEqual({ kind: "mem0", base: "https://api.mem0.ai", cloud: true, key: "k-1", allowed: true });
    expect(choose({ memory: "mem0", cloudProjects: [project] }, { envKey: "k-env" })).toMatchObject({ key: "k-env" });
  });

  it("asks for a key when the mem0 cloud has none", () => {
    expect(choose({ memory: "mem0" })).toEqual({ kind: "none", why: expect.stringContaining("MEM0_API_KEY") });
  });

  it("does not let a project into the cloud until the list has it", () => {
    expect(choose({ memory: "mem0", apiKey: "k-1" })).toMatchObject({ kind: "mem0", allowed: false });
  });

  it("takes an own server for any other address, for every project, and never gives it MEM0_API_KEY", () => {
    expect(choose({ memory: "mem0", url: "http://localhost:8888" }, { envKey: "k-env" })).toEqual({ kind: "mem0", base: "http://localhost:8888", cloud: false, key: undefined, allowed: true });
  });

  it("names the store and the place from the options alone", () => {
    expect(storeNameFor(options({ memory: "off" }))).toBeUndefined();
    expect(storeNameFor(options())).toBe("openviking");
    expect(storeNameFor(options({ memory: "mem0", url: "http://localhost:8888" }))).toBe("mem0-localhost-8888");
    expect(memoryWhere(choose({ memory: "mem0", url: "http://localhost:8888" }))).toBe("mem0 at http://localhost:8888");
    expect(memoryWhere(choose({ memory: "mem0", apiKey: "k-1" }))).toBe("mem0 cloud");
  });
});

describe("when not to sync", () => {
  const cloud = { kind: "mem0", base: "https://api.mem0.ai", cloud: true, key: "k-1", allowed: false } as const;

  it("stops for memory.enabled false even when the project is let in", () => {
    expect(memorySyncBlock({ ...config(), memory: { ...config().memory, enabled: false } }, { ...cloud, allowed: true }, project)).toContain("memory.enabled");
  });

  it("says how to send a project the cloud does not take yet", () => {
    expect(memorySyncBlock(config(), cloud, project)).toBe(`mem0 cloud is chosen, but ${project} is not sent there: /archivist memory on sends it.`);
  });

  it("lets a sync run when nothing stands in the way", () => {
    expect(memorySyncBlock(config(), { kind: "openviking", server: ov }, project)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `npx vitest run test/memory-choice.test.ts`
Expected: FAIL: модуля нет.

- [ ] **Step 3: Реализовать `src/core/memory-choice.ts`**

**`readMemoryOptions`**
- Список проектов в виде строки делится по `/[\s,]+/`. Принимается и массив.
- Пустые элементы и повторы выбрасываются.

**`cloudAllowedBy`**
- Сравнивает без учёта регистра и возвращает элемент так, как его набрали.
- `*` пропускает всё.
- `x/*` пропускает id, которые начинаются с `x/`.

**`chooseMemory`**
- Для облака `base = url || MEM0_CLOUD_URL`.
- Ключ — `apiKey` или, только для облака, `envKey`.
- `allowed = !cloud || Boolean(cloudAllowedBy(...))`.

**`memorySyncBlock`** проверяет по порядку:
1. `config.enabled`;
2. `config.memory.enabled` — текст `Memory sync is off: set memory.enabled to true in .archivist/config.json.`;
3. `choice.why`;
4. для невключённого облака — текст из теста.

**`memoryWhere`**
- OpenViking — имя сервера;
- облако — `mem0 cloud`;
- свой сервер — `mem0 at <base>`;
- `none` — пустая строка.

- [ ] **Step 4: Запустить**

Run: `npx vitest run test/memory-choice.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run check
git add src test plugin/hooks/register.js plugin/bin/archivist
git commit -m "Memory chosen from the plugin options; cloud only for listed projects"
```

---

### Task 9: Настройки плагина и мод

**Files:**
- Modify: `plugin/.claude-plugin/plugin.json` (`userConfig`)
- Modify: `src/core/config.ts:54-58,92` (без `server`)
- Modify: `src/adapters/claude/mod/register.ts`

**Interfaces:**
- Consumes: задачи 1–8.
- Produces: поведение мода. Юнит-тестов у мода нет. Проверяют `npm run typecheck`, сборка, `claude plugin validate --strict` и живая проверка в задаче 11.

- [ ] **Step 1: Объявить `userConfig` в `plugin/.claude-plugin/plugin.json`**

Схему уже принял `claude plugin validate --strict`:

```json
"userConfig": {
  "memory": {
    "type": "string",
    "title": "External memory",
    "description": "Where Archivist also keeps its entries: auto finds a connected OpenViking, mem0 uses the address and key below, off keeps them in project files only.",
    "options": ["auto", "openviking", "mem0", "off"],
    "default": "auto"
  },
  "memory_url": {
    "type": "string",
    "title": "mem0 address",
    "description": "Empty for the mem0 cloud. For your own mem0 server, its base URL, such as http://localhost:8888.",
    "default": ""
  },
  "memory_api_key": {
    "type": "string",
    "title": "mem0 API key",
    "description": "For the mem0 cloud, MEM0_API_KEY is used when this is empty. For your own server, the key it printed at setup; empty if it runs without auth.",
    "sensitive": true
  },
  "memory_cloud_projects": {
    "type": "string",
    "title": "Projects sent to cloud memory",
    "description": "Comma-separated project ids as /archivist memory shows them, owner prefixes such as github.com/owner/*, or * for all. /archivist memory on adds the current project.",
    "default": ""
  }
}
```

- [ ] **Step 2: Убрать `memory.server` из `Config` и `DEFAULT_CONFIG`**

- [ ] **Step 3: Переписать память в `register.ts`**

**Подключение настроек**
- `import type { On, PluginOptions } from 'claude-code'`.
- Состояние модуля: `let memoryOptions = readMemoryOptions({})`.
- Вход: `export function register(on: On, options: PluginOptions): void`, первая строка — `memoryOptions = readMemoryOptions(options)`.

**Функции верхнего уровня.** `memoryServer` и `NO_MEMORY` удаляются.
- `openVikingServer($)` — бывшее тело `memoryServer` без конфига.
- `gitConfigRemote($, base)` — `git -C <base> config --get remote.origin.url`.
- `mem0UserIds($)` возвращает кандидатов по порядку:
  1. строковое значение строки `/^mem0[^.]*\.user_id$/` из `$.config.list()`;
  2. `$.env.get` для `MEM0_CODE_USER_ID`, `MEM0_USER_ID`, `MEM0_RESOLVED_USER_ID`, `USER`, `USERNAME` — каждое имя литералом.
- `mem0Fetcher($): Fetcher` — `(url, init) => $.http.fetch(url, init)`.

**Цель синхронизации.** `memoryTarget($, base, config): Promise<{ choice: MemoryChoice; project: string; where: string; store?: MemoryStore }>`
- Проект — как сейчас.
- `openVikingServer` спрашивается только при `auto` и `openviking`.
- `envKey` — `await $.env.get('MEM0_API_KEY')`, только при `mem0`.
- Хранилище для mem0 строится из `mem0Scope({ rawRemote: await gitConfigRemote($, base), root: base, projectIdEnv: await $.env.get('MEM0_PROJECT_ID'), userIdCandidates: await mem0UserIds($) })` и `mem0Transport(mem0Fetcher($), choice.base, auth)`.
- `auth`:
  - облако — `{ header: 'Authorization', value: `Token ${key}`, secret: key }`;
  - свой сервер с ключом — `{ header: 'X-API-Key', value: key, secret: key }`;
  - без ключа — `undefined`.

**Фоновая синхронизация.** `syncToMemory($, base, mode: SyncMode)`:
- `loadConfig`;
- `storeNameFor(memoryOptions)`;
- `fast` и `memoryUpToDate(io, name)` — выход;
- `memoryTarget`;
- `memorySyncBlock` — при блоке выход. Если при этом режим `start`, а облако не включено, показать подсказку;
- `syncMemory`;
- строка в лог: `memory <mode> (<where>, <project>): <итог>`.

**Подсказка.** `hintCloudOnce($, base, project, text)`:
- ключ `$.store`: `archivist:cloud-hint:<project>`;
- при первом разе `$.ui.toast(text, { timeoutMs: cfg.report.toastMs })` и строка в лог.

**Команды.** `memoryCommand($, io, config, action)` целиком в `try/catch`. При ошибке ответ `Memory: <message>`.
- `status`: первая строка — `Memory: <where>, project <project>` или `choice.why`. Затем блок, если он есть, и `memoryLines(...)`.
- `sync`: блок или `syncMemory` в режиме `full`.
- `clear`: работает при любом `allowed`, если хранилище есть.
- `on` и `off`: `cloudProjectsCommand($, project, action)`.

**`cloudProjectsCommand`** ищет в `$.config.list()` строку `/^archivist[^.]*\.memory_cloud_projects$/` и пишет `withCloudProject` или `withoutCloudProject`, склеенные через `', '`, вызовом `$.config.set`. Ответы:

| Случай | Ответ |
|---|---|
| `on`, проект добавлен | `Added <project> to the projects sent to cloud memory; its entries go there after the plugin reloads.` |
| `on`, уже пропускает элемент `e` | `<project> already goes to cloud memory (<e> in /config).` |
| `off`, проект убран | `<project> no longer goes to cloud memory. What it sent stays there: /archivist memory clear removes it.` |
| `off`, пропускает префикс или `*` | `<project> goes to cloud memory because of <e> in /config (Archivist › Projects sent to cloud memory): change it there.` |
| `off`, проекта не было | `<project> is not sent to cloud memory.` |
| `{ deny }` | `Not changed: <deny>` |
| строки нет | `The plugin options are not available in this session: set them in /config.` |

**Health.** Передаёт `memoryNote: memorySyncBlock(...)`. Исключение — `auto`, когда ничего не подключено: тогда заметки нет.

**Регистрация команды.** `argumentHint` — `memory [status|sync|clear|on|off]`.

- [ ] **Step 4: Проверить**

Run: `npm run typecheck && npx vitest run && npm run build && claude plugin validate --strict plugin`
Expected:
- ошибок типов нет, тесты проходят, `✔ Validation passed`;
- в списке вызовов есть `$.http.fetch (via mem0Fetcher)`, `$.config.set (via cloudProjectsCommand)`, `$.config.list`, `$.env.get`.

- [ ] **Step 5: Commit**

```bash
npm run check
git add plugin src test
git commit -m "Plugin options choose the memory: OpenViking, the mem0 cloud or an own mem0 server"
```

---

### Task 10: Документация, CHANGELOG, версия

**Files:**
- Modify: `README.md` (разделы «Настройки», «Внешняя память», «Стоимость и приватность»)
- Modify: `docs/memory.md`
- Modify: `CHANGELOG.md`, `plugin/.claude-plugin/plugin.json`, `package.json`, `package-lock.json`

- [ ] **Step 1: README**

**«Настройки»**
- Строка `memory.server / memory.project` заменяется строкой `memory.project`: имя проекта в памяти, по умолчанию из `git remote`.
- Добавляется таблица «Настройки плагина (`/config`)» с четырьмя полями.

**«Внешняя память»**
- Систему выбирают в `/config`; `auto` находит OpenViking.
- mem0 бывает облачным и своим, и это определяется адресом.
- В облако уходят только включённые проекты (`/archivist memory on|off`).
- Свой сервер и OpenViking получают все проекты.
- Плагины mem0 для Claude Code, Codex и Cursor со своим сервером не работают.

**«Стоимость и приватность»** — новая строка: записи уходят в выбранную систему памяти. В облако mem0 они уходят только для включённых проектов и с ключом из настроек плагина. Свой сервер mem0 считает эмбеддинги через OpenAI или Gemini.

- [ ] **Step 2: `docs/memory.md`**

**Принцип**
- Пункт 6: где чтение тратит квоту, сверка идёт не чаще раза в сутки.
- Пункт 8: транспорт — MCP подключённого плагина или API со своим ключом из настроек плагина.
- Новый пункт 9: в чужое облако уходят только явно включённые проекты.

**Раздел mem0**
- Облако и свой сервер: таблица операций, скоуп, metadata.
- Чем платит дубль при изменении в облаке.

**Остальное**
- Таблица систем — по итогам разведки (см. спецификацию, «Заметки на следующие раунды»).
- «Настройки и команды»: без `memory.server`, с полями плагина и `on|off`.
- «Что дальше»: этапы 2 и 3 — версия 1.5.x, затем Hindsight и supermemory.

- [ ] **Step 3: CHANGELOG и версия**

Запись `## 1.5.0 — <дата коммита>`, четыре пункта по-английски:
1. Память выбирается в настройках плагина (`/config`): `auto`, `openviking`, `mem0`, `off`.
2. mem0 в облаке и на своём сервере через REST, дословно, со скоупом плагинов mem0.
3. Облако получает только проекты из личного списка (`/archivist memory on|off`). Его сверка идёт раз в сутки; отказ ключа или квоты ставит синхронизацию на паузу до следующей сессии.
4. `memory.server` убран из `.archivist/config.json`.

Затем:
- `version` в `plugin.json` — `"1.5.0"`;
- `npm version 1.5.0 --no-git-tag-version`.

- [ ] **Step 4: Проверить и искать утечки**

Run: `npm run check && claude plugin validate . --strict && git add README.md docs/memory.md CHANGELOG.md plugin package.json package-lock.json && git grep --cached -n -I -E "/Users/[a-z]|/private/tmp|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" -- ':!package-lock.json'`

Пути перечислены явно: Archivist ведёт журнал этого же репозитория, и `.archivist/` может измениться за время работы.
Expected:
- проверки проходят, `✔ Validation passed`;
- поиск утечек находит одну строку — `test/memory.test.ts:37` с выдуманным `/Users/me/My Project`.

- [ ] **Step 5: Commit**

```bash
git commit -m "v1.5.0: memory chosen in the plugin options; mem0 in the cloud and on an own server"
```

---

### Task 11: Живая проверка (делает пользователь)

Исполнитель здесь останавливается и передаёт проверку пользователю. Инструменты OpenViking без его согласия не вызывать.

1. `claude --plugin-dir ./plugin`, затем в `/config` выбрать mem0, адрес оставить пустым, указать ключ.
2. `/archivist memory` показывает `mem0 cloud` и строку о том, что проект не включён. Подсказка показана один раз.
3. `/archivist memory on`. После перезагрузки и одного хода записи появляются в mem0 — в дашборде или в recall плагина mem0 в этом репозитории.
4. `archivist deprecate <id>` — запись удалена из mem0.
5. Второй worktree не создаёт дублей.
6. Сравнить счётчики `GET /v1/stats/` до и после `/archivist memory sync`: так видно, тратит ли список квоту чтений.
7. Свой сервер: `make bootstrap` в `server/` репозитория mem0, в `/config` адрес `http://localhost:8888` и ключ из вывода bootstrap.
   - Записи видны в дашборде `http://localhost:3000` без `/archivist memory on`.
   - Изменение записи не меняет её id.
8. Что не проверено и что покажет живая проверка: ответ на повторное добавление, BYOK для `infer:false`, удаление `immutable`-записи, ответ своего сервера на `infer:false`, замена metadata при `PUT`.
