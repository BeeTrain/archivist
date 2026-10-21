# Этап 0: спайки

Окружение: Claude Code **2.1.304**, бинарник из бандла Claude Desktop, macOS, Node 26.8. Дата: 2026-10-21.

Чем воспроизвести:
- `spikes/logger-plugin/` — плагин с command-хуками, пишет payload каждого хука в `$ARCH_SPIKE_LOG`;
- `spikes/mod/` — dev-mod, проверяет mods API.

Статусы: ✅ подтверждено, ❌ опровергнуто, ⏳ ждёт прогона в живой сессии.

---

## 0. Главная находка: `claude -p` из десктоп-сессии не авторизован ❌

```
$ claude auth status        → {"loggedIn": false, "authMethod": "none"}
$ claude -p "…" --model haiku → result: "Not logged in · Please run /login", is_error: true
```

- Claude Desktop авторизует свою сессию через хост и не кладёт креды ни в окружение, ни в keychain CLI. Дочерние процессы, в том числе хуки плагина и всё, что они запускают, работают без авторизации. Результат тот же при унаследованном окружении (`env` хука) и при чистом (`env -i`).
- `--bare` требует `ANTHROPIC_API_KEY`. OAuth и keychain этот режим не читает.
- **Следствие.** Схема «хук запускает `claude -p`» из `PLAN.md` работает только у тех, кто отдельно залогинен в CLI (`claude auth login`, `claude setup-token`) или задал API-ключ. Для пользователей десктопа это не «бесшовно».
- **Решение:** запускать анализатор через **mods API** (`$.model.complete` / `$.model.fork`), который ходит в модель клиентом и кредами самой сессии (раздел 7). `claude -p` остаётся запасным путём для CLI с логином и для пакетного `archivist analyze` из терминала.

## 1. Рекурсия и отключение хуков во вложенном `claude -p` ✅

Хуки срабатывают даже без авторизации, поэтому это проверялось без модели. Плагин подключался через `--plugin-dir spikes/logger-plugin`.

| Запуск | Какие хуки сработали |
|---|---|
| обычный | SessionStart, InstructionsLoaded, UserPromptSubmit, SessionEnd |
| `--settings '{"disableAllHooks":true}'` | **ни одного**, в том числе хуки плагина |
| `--bare` (с явным `--plugin-dir`) | **ни одного** |
| `ARCHIVIST_CHILD=1` в окружении | все; переменная **доходит до хука**, guard работает |

- `--no-session-persistence` ✅: файл транскрипта не создаётся, хотя `transcript_path` в payload SessionStart есть. Без этого флага каждый запуск анализатора добавляет `.jsonl` в `~/.claude/projects/<cwd>/`. Это засоряет историю и baseline, тот же анти-паттерн, что у claude-self-reflect.
- Если задача не дошла до API (ошибка), `Stop` не срабатывает. SessionEnd с `reason: "other"` в `-p` срабатывает всегда.
- **Рецепт для запасного пути:** `ARCHIVIST_CHILD=1 claude -p --settings '{"disableAllHooks":true}' --no-session-persistence --model haiku --tools "" --max-turns 1 --output-format json --json-schema …`.

## 2. Отчёт пользователю после задачи ✅ (через mods) / ❔ (command-хуки)

Каналы mods проверены в этой десктоп-сессии (подробности в разделе 7):
- `$.prompt.submit` ✅ будит простаивающую сессию. Ход начинается с сообщения «The archivist-spike plugin sent a message: …», origin `{ kind, name }`. Агент получил текст как информацию и ответил одной строкой, работу не продолжал. **Это рабочая замена `asyncRewake`.** Каждый вызов стоит один ход основной модели, поэтому использовать его можно только по opt-in (режим `rewake`).
- `$.ui.notify` ❌ в десктопе: `{ isSent: false, reason: "no-surface" }`, как и сказано в документации (desktop, `-p`, SDK). Нужен fallback на `$.ui.toast`.
- `$.ui.status` ✅ **виден в десктопе постоянно**: справа внизу у поля ввода, с именем плагина («archivist-spike · archivist-spike: turn 2 analysed»). Это самый заметный канал без токенов.
- `turn.complete → { text }` ✅ записывается в транскрипт как `{"type":"system","subtype":"informational","level":"notice"}` с префиксом всех плагинов, участвовавших в событии (`archivist-spike+cc-plugin-agents-md: 📚 …`). В десктопе показывается **свёрнутым блоком «Claude Code notice ›»**, заметность низкая. В контекст модели не попадает, токенов не стоит.
- `$.ui.toast` ❔ ошибок нет, но на скриншоте после хода его уже не было: по умолчанию он держится 4 с. В v1 нужен `{ timeoutMs }` побольше, и проверить ещё раз.

**Схема отчёта для десктопа:**
- `status` — короткий итог, остаётся на экране: «📚 +2 записи · 1 на ревью · /archivist:report»;
- `notice` — подробности;
- `toast` с увеличенным `timeoutMs` — сигнал «готово»;
- `/archivist:report` — полный отчёт в панели.

Command-хуки (`systemMessage` и `asyncRewake` на Stop) ❔ не проверены:
- без авторизованного `claude -p` они не запускаются;
- в dev-моде при горячей перезагрузке регистрируется только `modules`, а секцию `hooks` из `hooks.json` движок не подхватил: `UserPromptSubmit` и `Stop` ни разу не сработали, хотя скрипт исправен при ручном запуске;
- раз ядро переходит на mods, этот спайк не блокирует работу. Вернуться к нему стоит, если понадобится поддержка версий Claude Code без mods (< 2.1.290).

## 3. Detached-процесс переживает выход Claude Code ✅

SessionEnd-хук запускал `spawn('/bin/sh', …, { detached: true, stdio: 'ignore' }).unref()` с задачей `sleep 15` и записью маркера.

```
claude exited at 1792599579
маркер: "alive ppid=1 1792599594"   ← через 15 с, родитель стал launchd
```

Фоновый анализатор из SessionEnd можно запускать, если вывод перенаправлен (`stdio: 'ignore'`) и процесс отсоединён (`detached` + `unref`). Бюджет самого хука (1.5 с) не мешает.

## 4. Формат транскрипта JSONL (v2.1.304) ✅

Путь: `~/.claude/projects/<cwd с заменой не-алфанумерики на '-'>/<session_id>.jsonl`. Рядом лежит каталог `<session_id>/`:
- `subagents/agent-<id>.jsonl` (+ `.meta.json`, `.prefix.json`) — транскрипты субагентов, `isSidechain: true`, есть `agentId`;
- `tool-results/` — большие выводы инструментов, вынесенные из основного файла.

Типы записей верхнего уровня (на транскрипте этой сессии, 256 строк):

| `type` | Что внутри | Нужно нам |
|---|---|---|
| `user` | `message.content`: строка (промпт) **или** блоки `tool_result`; `toolUseResult` — структурированный результат: Bash `{stdout, stderr, interrupted}`, Edit/Write `{filePath, structuredPatch, originalFile…}`, Agent `{agentId, status, …}`; `promptId`, `permissionDecision`, `isMeta` | ✓ промпты, результаты, ошибки |
| `assistant` | **одна запись на один content-блок** (`text` / `thinking` / `tool_use`), `message.id` общий для блоков одного ответа, `message.usage`, `requestedModel`, `effort` | ✓ вызовы инструментов, токены |
| `system` | `subtype: "stop_hook_summary"` (`hookCount`, `hookErrors`, `preventedContinuation`, `hookAdditionalContext`) | диагностика хуков |
| `attachment` | `attachment.type`: `instructions`, `skill_listing`, `date`, `total_tokens_reminder`, `queued_command`, `deferred_tools_delta`, … | какие инструкции загружены |
| `file-history-snapshot` / `-delta` | бэкапы правок | — |
| `api-request`, `api-request-blob`, `api-request-shape` | внутренние снимки запросов | не трогать |
| `queue-operation`, `last-prompt`, `custom-title`, `agent-name`, `atis-latch` | служебные | — |

Подсчёт токенов ✅:
- usage одинаков у всех блоков одного `message.id`, поэтому **дедуплицировать по `message.id`**: 55 записей assistant, 21 уникальный id.
- Поля: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, а также `cache_creation.{ephemeral_1h,5m}`, `server_tool_use`, `iterations`, `speed`.
- Пример для этой сессии на момент замера: input 50, cache_read 2.77M, cache_write 121k, output 43.6k.

Выводы:
- Формат внутренний и меняется. Типов служебных записей заметно больше, чем описано в сторонних парсерах.
- Парсер должен быть **толерантным**: whitelist типов `user`/`assistant`/`system`, неизвестное игнорировать, фикстуры в тестах.
- При варианте с mods основной источник — `$.session.messages()`, это стабильный API, а JSONL нужен только для `archivist baseline` по старым сессиям.

## 5. `InstructionsLoaded` ✅

При старте сессии (без общих полей):
```json
{ "hook_event_name": "InstructionsLoaded", "file_path": "~/.claude/CLAUDE.md",
  "memory_type": "User", "load_reason": "session_start" }
```
Для `.claude/rules/spike-paths.md` с `paths: ["spikes/fixtures/rules/**"]` при `Read spikes/fixtures/rules/a.txt` пришёл (через `classic.InstructionsLoaded` в моде):
```json
{ "file_path": ".../.claude/rules/spike-paths.md", "memory_type": "Project",
  "load_reason": "path_glob_match", "globs": ["spikes/fixtures/rules"],
  "trigger_file_path": ".../spikes/fixtures/rules/a.txt" }
```
- Событие приходит **один раз на rule за сессию**: при чтении `b.txt` его не было.
- `globs` нормализованы, хвост `/**` отброшен.
- **Для Archivist** это точный сигнал использования path-scoped записи: какой rule, из-за какого файла и когда. Отсюда счётчик `seen` и атрибуция helpful/harmful.

## 6. Подхват изменений `.claude/rules/` в середине сессии ✅

1. Rule создан **в середине сессии**. При первом чтении подходящего файла текст «v1 ALPHA» сразу попал в контекст как содержимое файла.
2. Rule изменён на «v2 BETA», затем прочитан другой подходящий файл. Повторной загрузки нет, но модель получила заметку «file changed on disk since you last read it» с актуальным содержимым, потому что загруженный rule отслеживается как прочитанный файл.

**Вывод.** Archivist может рендерить и обновлять `.claude/rules/archivist/*.md` прямо во время сессии:
- новый файл подхватится при первом касании подходящих путей;
- правка уже загруженного файла дойдёт до модели как diff.

Значит, записи, сделанные после задачи, работают уже в той же сессии, если она продолжается. Обратная сторона: каждая правка загруженного rule сразу добавляет diff в контекст. Поэтому рендер делаем пачкой, а не по одной записи.

## 7. Monitors и mods ✅ (документация) / ⏳ (практика)

**Monitors** (`monitors/monitors.json`):
- постоянный фоновый процесс, каждая строка stdout приходит **Claude** как уведомление;
- работает только в интерактивных сессиях, в `-p` никогда, переменных `userConfig` не получает;
- для отчёта пользователю mods подходят лучше: monitor тратит ход модели на каждое уведомление.

**Mods** (hooks module в `hooks/hooks.json → "modules"`, TS/JS, Terminal + Desktop + VS Code, v2.1.290+). Возможности, которые закрывают проблемы плана:

| Задача Archivist | API мода |
|---|---|
| вызвать LLM без `claude -p` и отдельной авторизации | `$.model.complete({ model: 'haiku', prompt, system, maxTokens, timeoutMs })` — клиент и креды сессии, без истории |
| дешёвый анализ «что решили в задаче» | `$.model.fork({ prompt })` — вопрос поверх **собственного транскрипта сессии, префикс из prompt cache**, без инструментов |
| история задачи без парсинга JSONL | `$.session.messages()`: `{ role, text, toolUses[{…, result, isError}], toolResults }`, до 4096 последних |
| токены и стоимость | `turn.complete` → `e.usage`; `$.session.usage()` → `{ startedAt, context, rateLimits, cost }` |
| граница задачи | `turn.start` / `turn.complete` (`turnId`, `answer`, `durationMs`, `isAborted`, `agentId`) |
| отчёт после задачи | `turn.complete → { text }` (строка под ответом), `$.ui.toast/status/notify`, панель `$.ui.open` + `ui.render` |
| фоновая работа после хода | `$.clock.after/every`; работа, начатая в `turn.complete`, обрывается вместе с dispatch, поэтому долгое — через таймер |
| разбудить сессию с отчётом | `$.prompt.submit({ text })` — новый ход, когда сессия простаивает |
| своё хранилище | `$.store` (KV, общий для сессий машины, 4 MiB), `$.fs.read/write` |
| классические события | `classic.<Event>` с тем же payload, что у command-хуков (`classic.InstructionsLoaded`, `classic.PostToolUse`, …) |
| свои команды и инструменты | `$.command.register`, `$.tool.register`, `$.agent.register/spawn` |

Ограничения:
- хук выполняется до 10 с, но время внутри вызовов `$` не учитывается;
- все хуки `session.end` вместе укладываются в 1.5 с;
- у `$.model.complete` по умолчанию `maxTokens` 1024, максимум 64k;
- `$.fs` до 4 MiB на файл;
- в модуле нет Node и DOM, всё идёт через `$`;
- валидатор статически требует литералы в `on("…")`, а `$` можно передавать только функциям, объявленным на верхнем уровне файла.

### Практическая проверка `spikes/mod/` в десктоп-сессии ✅

Фоновая задача запускалась через `$.clock.after(1500, …)` из `turn.complete`.

| Вызов | Результат |
|---|---|
| `turn.complete` `e` | `{ answer, durationMs, isAborted, turnId, reason, usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model} }`. Пример: 48 с, out 3.6k, cache_read 1.08M, `claude-opus-5-5`. **usage считается за ход, суммой по всем запросам хода**, это готовая метрика «стоимость задачи» |
| `$.session.usage()` | `{ startedAt, context{tokens: 272438, window: 1000000, percent: 27}, rateLimits[2]{kind, percentUsed, resetsAt}, cost{usd: 9.96} }` |
| `$.session.messages()` | 224 сообщения `{ role, text, toolUses[{tool_use_id, tool, input, result, text}] }`. Хватает для дайджеста задачи без JSONL |
| `$.model.complete({ model: 'haiku', … })` | ✅ **работает на авторизации десктоп-сессии**: 1.4 с, `"PONG"`, usage in 19 / out 5 |
| `$.model.fork({ prompt })` | ✅ 4.6 с, осмысленный ответ по сути задачи. usage: input 30, **cache_read 272 436**, cache_write 602, out 176. Весь контекст сессии пришёл из кэша, по цене ≈ 0.1× обычного входа основной модели |
| `$.ui.notify` | ❌ `no-surface` в десктопе |
| `$.prompt.submit` | ✅ новый ход начинается с сообщения плагина, `origin: { kind, name }` |
| `$.fs.write` по абсолютному пути вне проекта | ✅ |

Особенности, которые нашлись по ходу:
- **Горячая перезагрузка мода сбрасывает таймеры.** Если файлы мода менялись в ходе, мод перезагружается сразу после `turn.complete`, и `$.clock.after` не срабатывает. В разработке мод нельзя править в том же ходу, в котором он должен отработать. В продакшене (установленный плагин) это неважно, но незавершённую фоновую работу всё равно нужно сохранять до таймера (`$.store`), чтобы переживать reload.
- `$.store` **общий для всех сессий машины** и переживает перезагрузки. Флаги «один раз» из спайка (`fork-done`, `submit-done`) остаются, их нужно учитывать при повторных прогонах.
- Конкурентные `classic.*` хуки делают append через read+write, это **не атомарно**. Для журнала нужна очередь в памяти модуля с одним писателем или отдельный файл на событие.
- Валидатор статически требует литерал в `on('…')`. `$` можно передавать только функции, объявленной на верхнем уровне файла.

Оценка стоимости анализа задачи:
- **`fork`** спрашивает поверх уже закэшированного контекста основной модели. Платим за cache read всего контекста (≈ 0.1×) и за output. Зато модель видит рассуждения и решения целиком, а не пересказ.
- **`complete`** на haiku с дайджестом 10–15k: дешевле на длинных сессиях, но видит только дайджест.
- **Вариант для v1:**
  - `fork` с коротким вопросом-извлечением для решений и выводов, только если задача нетривиальна (пороги из `PLAN.md`);
  - `complete` на haiku для курирования: дедуп и формулировка дельта-операций против top-k существующих записей;
  - оба с бюджетом.

---

## Итог этапа 0 и решения для архитектуры

| # | Вопрос | Итог |
|---|---|---|
| 1 | Рекурсия во вложенном `claude -p` | ✅ `disableAllHooks` / `--bare` + `ARCHIVIST_CHILD` + `--no-session-persistence`. Но из десктопа `-p` **не авторизован** |
| 2 | Отчёт после задачи | ✅ через mods (`turn.complete`-строка, toast/status, `prompt.submit`); ❔ command-хуки не проверены, не блокирует |
| 3 | Detached-процесс после SessionEnd | ✅ живёт |
| 4 | Формат JSONL | ✅ описан; внутренний, нужен толерантный парсер, только для `baseline` |
| 5 | `InstructionsLoaded` | ✅ `path_glob_match` + `trigger_file_path`, один раз на rule |
| 6 | Правки rules в середине сессии | ✅ новый rule подхватывается, правка уже загруженного приходит как diff |
| 7 | Monitors / mods | ✅ mods закрывают авторизацию, историю, стоимость и отчёт |

Решения:
1. **Интеграция с Claude Code — mod** (`hooks/hooks.json → modules`). Он делает:
   - журнал задачи и метрики (`turn.*`, `classic.PostToolUse`/`PostToolUseFailure`/`InstructionsLoaded`, `session.usage`);
   - фоновый анализ после хода через `$.clock.after` и `$.model.fork`/`complete`;
   - отчёт: строка под ответом, toast/status, панель `/archivist:report`, по opt-in `prompt.submit`.
2. **`claude -p` — только запасной путь** для `archivist analyze` из терминала (CLI с логином или API-ключ) и для будущих адаптеров.
3. **Ядро Archivist** (ledger, merge, render, валидация, метрики) — агент-агностичный TS без Node-зависимостей в рантайм-части. Mod импортирует его как модуль: в моде нет Node, весь I/O идёт через `$.fs`. CLI на Node использует то же ядро с адаптером I/O на `node:fs`.
4. Минимальная версия Claude Code — **2.1.290** (mods). Для более старых версий режим не поддерживаем.
5. В `PLAN.md` обновлены разделы 0, 3.1, 3.4–3.6, 3.10, 5 и 6.
