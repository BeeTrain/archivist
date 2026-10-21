# Archivist: план реализации

> CLI и плагин для Claude Code. На старте задачи плагин подключается к сессии агента, по ходу работы собирает факты о проекте и принятые решения, а после задачи анализирует сессию и обновляет набор документов. Цель документов — экономить время, токены и контекст в следующих задачах. В конце задачи пользователь получает отчёт: что добавлено, какие сделаны выводы, сколько ресурсов это должно сэкономить.
>
> Версия плана: 2026-10-21. v1 поддерживает только Claude Code, ядро при этом не привязано к конкретному агенту.

---

## 0. Короткий итог

- **Рекомендуемая архитектура: вариант D (гибрид).** Хуки только пишут журнал событий, это дёшево и без LLM. После задачи запускается фоновый анализ. Модель возвращает **дельта-операции** над атомарными записями (ADD / UPDATE / DEPRECATE / REINFORCE / NOOP), а применяет их детерминированный код.
- **Интеграция с Claude Code — mod** (hooks module плагина, Claude Code ≥ 2.1.290). Это решение принято после этапа 0, подробности в `docs/spikes.md`. Модель вызывается через `$.model.fork`/`$.model.complete` на авторизации самой сессии. Вариант с `claude -p` из хука не годится: в Claude Desktop он не авторизован. История и стоимость берутся через `$.session.*`, отчёт показывается строкой под ответом, toast'ом или в панели. `claude -p` остаётся запасным путём для CLI.
- **Хранилище знаний лежит в репозитории** (`.archivist/`) и состоит из append-only журнала (ledger) и сгенерированных из него представлений. Агент получает знания штатными механизмами Claude Code: `.claude/rules/` (в том числе path-scoped правила с ленивой загрузкой), skills и короткий индекс. Своя инъекция контекста минимальна.
- **Минимализм в слое, который загружается всегда.** Записываем только то, что агент сам не выведет из кода: команды, неочевидные ловушки, решения и их причины. Обзоры кодовой базы не пишем: по данным исследований они не помогают и удорожают работу (подробнее в п. 1.3).
- **Человек в цикле.** Изменения с высокой уверенностью применяются автоматически в файлы `.archivist/` и `.claude/rules/archivist/`. Всё остальное, в том числе любые правки чужих файлов вроде `CLAUDE.md`, попадает в очередь на ревью.
- **Пользу измеряем.** Метрики на каждую задачу (токены, число Read/Grep до первой правки, повторные чтения, неудачные команды) сравниваются с baseline, построенным по историческим транскриптам.

---

## 1. Исследование готовых реализаций

### 1.1. Плагины и инструменты памяти для Claude Code

| Инструмент | ★ (≈) | Подход | Что хорошо | Что плохо |
|---|---|---|---|---|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 102k | Каждый вызов инструмента (PostToolUse, async) уходит в локальный worker. Фоновая observer-сессия через Agent SDK сжимает их в типизированные observations. Хранение: SQLite + FTS5 + Chroma. Поиск через MCP в 3 слоя (`search` → `timeline` → `get_observations`) | Progressive disclosure в поиске; теги `<private>`; веб-просмотрщик; подсказка по файлу на PreToolUse | **Observer тратит токенов почти как сама работа**: 245M против 348M (#4965), +64% к расходу (#3848). Мусорные `CLAUDE.md` в подпапках (#609, #697). Сотни процессов-сирот (#701). Бесконечный цикл, когда summary в Stop воспринимается как инструкция (#987). Телеметрия включена по умолчанию (#4605). Тяжёлые зависимости: Bun, Chroma, HTTP-порт |
| [GWUDCAP/cc-sessions](https://github.com/GWUDCAP/cc-sessions) | 1.5k | Workflow DAIC: правки запрещены до одобрения плана. Задачи хранятся в md-файлах с Work Log, их обновляют субагенты | Задача переживает перезапуски, к задаче привязана ветка | Навязчивый процесс, хрупкие хуки, субагенты читают весь транскрипт. Заброшен с декабря 2025 |
| [centminmod/my-claude-code-setup](https://github.com/centminmod/my-claude-code-setup), [hudrazine/claude-code-memory-bank](https://github.com/hudrazine/claude-code-memory-bank) | 2.7k / 42 | Memory bank в стиле Cline: `CLAUDE-activeContext/patterns/decisions/troubleshooting.md`, обновление командой | Прозрачно, всё в git, удобно ревьюить | Держится на дисциплине пользователя. `@import` грузит всё в каждую сессию, поэтому centminmod перешёл на чтение по требованию |
| [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 2.0k | SessionStart с ранжированием по качеству, давности и git-контексту (до 14 записей). Mid-conversation хук срабатывает при смене темы. SessionEnd-harvest | Продуманные пороги: `minSessionMessages: 10`, `dryRunOnFirstUse`; LLM только по opt-in | Regex-эвристики дают шум; нужен отдельный HTTP-сервер; SessionStart зависает на Windows |
| [basic-memory, plugin claude-code](https://github.com/basicmachines-co/basic-memory/tree/main/plugins/claude-code) | 4.3k | Markdown-граф и SQLite-индекс. SessionStart отдаёт бриф детерминированными запросами по схеме (`type=decision status=open`), PreCompact пишет checkpoint | **Лучший дизайн-документ**: работает поверх нативной auto-memory; бюджет SessionStart меньше 1 с; принцип «пиши сразу, обогащай потом»; все ошибки завершаются с exit 0 | Записи делает сам агент, LLM-прохода пока нет |
| [oraios/serena](https://github.com/oraios/serena) (memories) | 30.6k | `.serena/memories/*.md` в репозитории. Агенту при старте передаётся только список имён, точка входа `mem:core` | Минимализм, ноль накладных расходов, память живёт в git | Захват целиком зависит от того, вспомнит ли агент записать |
| [campfirein/byterover-cli](https://github.com/campfirein/byterover-cli) (бывший Cipher) | 4.9k (архивирован) | Перехватывает записи нативной auto-memory через PostToolUse и курирует их LLM. Recall на UserPromptSubmit | Версионирование знаний, review операций curate | CLI заархивирован, продукт ушёл в облако |
| [affaan-m/ECC continuous-learning-v2](https://github.com/affaan-m/ECC/tree/main/skills/continuous-learning-v2) | 285k (весь репозиторий) | Сырой лог инструментов. Демон периодически вызывает `claude --model haiku -p` с env-guard `ECC_SKIP_OBSERVE=1`. Атомарные «инстинкты» с confidence. `/evolve` превращает их в skill | Атомарность, confidence, scope project/global, повышение до global после 2+ проектов, рост в skills | Демон зависает на macOS. Батчи тихо теряются (#2370). **v1 не работал вообще**: Stop-хук писал в stderr, а stderr не доходит до модели (#3260) |
| [rlancemartin/claude-diary](https://github.com/rlancemartin/claude-diary) | 380 | `/diary` пишет запись в дневник, `/reflect` выделяет паттерны и превращает их в правила CLAUDE.md | Порог паттерна 2+ повторения. **Нарушение уже существующего правила получает наивысший приоритет**. `processed.log` для идемпотентности | Автохук не работает: `echo "/diary"` в PreCompact ничего не запускает (#2) |
| [BayramAnnakov/claude-reflect](https://github.com/BayramAnnakov/claude-reflect) | 1.8k | UserPromptSubmit ловит поправки пользователя и кладёт в очередь. `/reflect` применяет их через ручной Apply/Edit/Skip в CLAUDE.md, AGENTS.md или skills | Поправки пользователя как главный сигнал; `--scan-history` по старым JSONL; `--dedupe`; `/reflect-skills` | Ложные срабатывания regex (#43) |
| [blader/Claudeception](https://github.com/blader/Claudeception) | 2.4k | На каждом промпте вставляет напоминание «нет ли чего извлечь», агент сам пишет новые SKILL.md | Знания растут в виде skills | Расход токенов на каждом ходе; skills разрастаются без дедупа |
| [coleam00/claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) | 1.3k | SessionEnd и PreCompact копируют транскрипт и запускают detached `flush.py` (Agent SDK, `allowed_tools=[]`, `max_turns=2`, ответ `FLUSH_OK` означает «нечего сохранять»). Дальше daily log компилируется в wiki | **Ближе всего к нашей схеме**: хук только делает I/O; recursion guard; дедуп по session_id; lint противоречий | В compile и query подставляется вся wiki: жалобы на «100% лимита Max за 20 минут» (#3, #5). Компиляция по времени «после 18:00» |
| [supermemoryai/claude-supermemory](https://github.com/supermemoryai/claude-supermemory) | 2.8k | Облачный push-recall на UserPromptSubmit, на Stop захватывается дельта | Дедуп инъекций в пределах сессии, advisory-режим | Данные уходят третьей стороне |
| [ramakay/claude-self-reflect](https://github.com/ramakay/claude-self-reflect) | 230 | Rust-бинарник: векторный поиск по всем прошлым транскриптам | Один бинарник, работает локально | Сами авторы показали, что kNN по транскриптам находит «эхо» вопроса, а не решение |
| **Anthropic**: нативная auto-memory, [`claude-md-management`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-md-management) (`/revise-claude-md`) | — | `MEMORY.md` как индекс (первые 200 строк или 25KB) плюс topic-файлы по требованию; типы user/feedback/project/reference. Изменения CLAUDE.md идут через diff и одобрение | Эталонный минимум: индекс отдельно от деталей, не хранить то, что выводится из кода, ревью правок | Нет пост-анализа сессии и метрик |

### 1.2. Подходы за пределами Claude Code

- **Cline Memory Bank** использует 6 фиксированных файлов, каждый `update memory bank` переписывает их целиком. Kilo Code уже пометил его deprecated в пользу **AGENTS.md**. Рынок уходит от фиксированных файлов к AGENTS.md с иерархией.
- **AGENTS.md** ([agents.md](https://agents.md/)) — стандарт под Linux Foundation. Его читают Codex, Gemini CLI, Cursor, Copilot, Windsurf, Aider, Zed и Claude Code (с v2.1.277). Это канонический формат для экспорта в будущих адаптерах.
- **GitHub Copilot Memory** ([docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)): у каждого факта есть **citations на код**, перед использованием они **проверяются на текущей ветке**. Неиспользуемый факт удаляется через 28 дней, использование продлевает срок. Самый полезный для нас приём борьбы с устареванием.
- **Codex Memories**: анализ запускается в фоне только для **простаивающих** тредов, короткие пропускаются. Две фазы: per-chat extraction, потом global consolidation. Секреты вырезаются. Учитывается остаток rate limit.
- **mem0**: кандидат сравнивается с top-k похожих записей, LLM выбирает ADD/UPDATE/DELETE/NOOP. **Graphiti/Zep**: противоречащая запись помечается недействительной (bi-temporal), а не удаляется. **Letta sleep-time agents**: отдельный асинхронный агент переписывает память вместо основного, это прямой аналог нашего анализатора.
- **ACE, Agentic Context Engineering** ([arXiv 2510.04618](https://arxiv.org/html/2510.04618)) — главный референс:
  - три роли: Generator → Reflector → Curator;
  - bullet хранится как `{id, helpful_count, harmful_count, content}`, merge **детерминированный и без LLM**;
  - главный довод — **context collapse при полном переписывании**: у Dynamic Cheatsheet память сжалась с 18 282 до 122 токенов, а точность упала ниже baseline;
  - append-only playbook даёт 91.8% попаданий в prompt cache.
- **Agent Workflow Memory / Voyager**: повторяющиеся процедуры выносятся в переиспользуемые workflows или skills, но **только после проверки**.

### 1.3. Эмпирика: что реально экономит ресурсы

- **ETH, «Evaluating AGENTS.md»** ([arXiv 2602.11988](https://arxiv.org/html/2602.11988v1)):
  - context-файлы, сгенерированные LLM, снижают успех на 0.5–2% и **повышают стоимость на 20–23%**;
  - overview кодовой базы **не ускоряет поиск нужных файлов**;
  - агенты выполняют всё, что написано в файле: больше тестов, grep и чтений;
  - вред в основном от **дублирования уже существующих доков**.
- **«On the Impact of AGENTS.md on Efficiency»** ([arXiv 2601.20404](https://arxiv.org/html/2601.20404v2)): хорошие файлы дают −28.6% медианного времени и −16.6% output-токенов при том же качестве. Механизм: агенту не нужно угадывать структуру и build/test-команды.
- **Индексаторы кода** (Aider repo-map, Serena/LSP, claude-context, codebase-memory-mcp) отвечают на вопрос «где и что». Ни один не хранит «**как у нас принято и почему**»: команды, ловушки, решения. Это и есть ниша Archivist. Индексатор мы не пишем.

### 1.4. Выводы для дизайна

**Заимствуем:**

1. Хук делает только I/O, а тяжёлая работа уходит в detached-процесс (memory-compiler, ECC). Бюджет SessionEnd всего 1.5 с.
2. Recursion guard для вложенного `claude -p`: своя env-переменная, `disableAllHooks` и `--no-session-persistence`.
3. Явный «пустой» исход (`NOOP`) и пороги: большинство задач не должно порождать новых записей.
4. Дельта-операции над атомарными записями и детерминированный merge (ACE, mem0).
5. Помечать недействительным вместо удаления, ADR-стиль `supersedes` (Graphiti, ADR).
6. Citations на код, валидация перед использованием, decay по неиспользованию (Copilot Memory).
7. Поправки пользователя и нарушения существующих правил как сигналы с наивысшим приоритетом (claude-reflect, claude-diary).
8. Progressive disclosure: короткий индекс плюс детали по требованию (нативная auto-memory, Serena, skills).
9. Ревью через diff для всего, что меняет чужие файлы (`/revise-claude-md`).
10. Fail-open: при любой ошибке exit 0 и запись в лог. О проблеме сообщаем при следующем SessionStart.

**Избегаем:**

1. LLM-observer на каждый вызов инструмента без бюджета (claude-mem).
2. Передачу в промпт всей базы знаний (memory-compiler). Отбор делается до LLM.
3. Запись файлов в произвольные места репозитория, `CLAUDE.md` в каждой подпапке.
4. Текст из Stop-хука, похожий на инструкцию: он вызывает бесконечный цикл. Обязательно проверяем `stop_hook_active`.
5. Расчёт на то, что stderr или stdout хука дойдёт до модели там, где это не так (ECC v1, claude-diary).
6. Инъекцию, меняющуюся на каждом ходе: она рвёт prompt cache и сбивает фокус.
7. Голый kNN по сырым транскриптам.
8. Regex как единственный фильтр.
9. Тихую потерю данных: батч помечается обработанным только после успешной записи.
10. Демонов, порты и тяжёлые рантаймы.
11. Телеметрию и облако по умолчанию.

---

## 2. Варианты реализации

### Вариант A. «Нативный»: агент сам ведёт документацию

Плагин состоит из skills и одного Stop-хука. В конце задачи хук **однократно** возвращает `decision: "block"` с просьбой к основному агенту обновить `.archivist/` по шаблону и кратко отчитаться.

- ➕ Ноль инфраструктуры. Агент лучше всех знает, какие решения принимал и почему. Его контекст уже в кэше, поэтому токены дешёвые.
- ➖ Засоряет основной контекст. На каждую задачу добавляется задержка и расход токенов дорогой модели (Opus). Качество зависит от дисциплины модели. Есть риск циклов. Это навязчиво.
- Где пригодится: как ручной режим `/archivist:reflect` и как источник «решений» через skill `/archivist:decide` в гибриде.

### Вариант B. «Наблюдатель и фоновый анализатор»

Хуки пишут журнал (PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, PostCompact). После задачи detached-процесс собирает дайджест задачи и вызывает дешёвую модель (`claude -p`, haiku или sonnet, `--json-schema`). Модель возвращает дельта-операции, код валидирует их, применяет и рендерит представления.

- ➕ Не мешает основной работе. Дешёвая модель, бюджет под контролем, merge детерминированный, результат воспроизводим. Работает даже при выключенном отчёте.
- ➖ Анализатор заново читает дайджест (токены без кэша). Рассуждения агента, не попавшие в транскрипт, теряются. Транскрипт имеет внутренний формат, поэтому нужен толерантный парсер.

### Вариант C. «Сервис памяти»

Отдельная БД с эмбеддингами, recall через MCP или на UserPromptSubmit, как у claude-mem, mcp-memory-service и supermemory.

- ➕ Масштабируемый поиск, общая память между проектами.
- ➖ Тяжёлые зависимости и демоны. Непрозрачно, нельзя ревьюить в git. Эмпирически раздувает токены. Для нашей цели, то есть для «как и почему» в объёме десятков и сотен записей, это избыточно.

### Вариант D (рекомендуемый). Гибрид B, A-lite и C-lite

- **Ядро — B**: журнал, фоновый анализатор с дельтами, ledger в репозитории.
- **A-lite**: skills `/archivist:decide` и `/archivist:remember`, чтобы агент или пользователь фиксировали решение сразу. Используются по требованию, без принудительного Stop-блока.
- **C-lite**: `archivist recall <запрос>` лежит в `bin/` плагина и попадает в PATH Bash-инструмента. Это BM25 по записям без эмбеддингов и демонов. Агент может дёшево спросить «что мы знаем про X», не загружая всё.
- **Доставка знаний** идёт штатными средствами Claude Code: `.claude/rules/archivist/*.md`, где path-scoped ловушки подгружаются **сами** при работе с нужными файлами, плюс skills для процедур.

### Сравнение

| Критерий | A | B | C | **D** |
|---|---|---|---|---|
| Незаметность для основной задачи | ✗ | ✓ | ~ | ✓ |
| Стоимость в токенах | средняя (дорогая модель) | низкая (haiku, бюджет) | высокая | низкая |
| Качество «почему» (решения) | ✓✓ | ~ | ~ | ✓ |
| Прозрачность и ревью в git | ✓ | ✓ | ✗ | ✓ |
| Зависимости | нет | Node | БД, вектора, демон | Node |
| Масштабирование до многих агентов | ✗ | ✓ | ✓ | ✓ |

---

## 3. Целевая архитектура (вариант D)

### 3.1. Компоненты

```
┌──────────── Claude Code session (mod) ───────────────────────┐
│ hooks/hooks.json → modules: ["./register.ts"]                 │
│   turn.start/turn.complete, classic.PostToolUse(Failure),     │──► журнал задачи (в памяти модуля → $.fs, один писатель)
│   classic.InstructionsLoaded, session.end                     │
│ skills: report, review, decide, remember                      │
│ $.command.register: /archivist:report, /archivist:status       │
│ bin/archivist (в PATH): recall, status                        │
└───────────────────────────────────────────────────────────────┘
          │ turn.complete (+ idle-таймер $.clock.after) / session.end / PreCompact
          ▼
┌──────────── фоновый анализ (внутри мода, вне dispatch хода) ──┐
│ 1 collect   → сегмент задачи ($.session.messages + журнал + usage + git diff через $.process)
│ 2 measure   → метрики и сигналы потерь (без LLM)
│ 3 gate      → тривиальная задача? → NOOP, выход
│ 4 digest    → сжатый дайджест ≤ ~15k токенов, redaction секретов
│ 5 retrieve  → top-k релевантных записей (по путям и BM25), не вся база
│ 6 reflect   → $.model.fork (извлечь решения/выводы) → $.model.complete haiku (курировать) → дельта-операции JSON
│ 7 validate  → evidence существует? дубль? бюджеты? confidence → auto | proposal
│ 8 apply     → ledger.jsonl (append) → render views
│ 9 report    → .archivist/reports/<ts>.md + доставка пользователю
└─────────────────────────────────────────────┘
```

### 3.2. Модель данных: запись (entry)

Записи атомарные: одна запись — один факт или правило. Пример:

```yaml
id: gk-7f3a            # стабильный id
type: command | gotcha | decision | convention | procedure | preference | hotspot
title: "Тесты одного модуля"
content: "Запускай `pnpm vitest run <path>` вместо `pnpm test` (полный прогон ≈ 4 мин)."  # 1–3 строки, повелительное наклонение
rationale: "Полный прогон поднимает e2e-окружение."   # для decision обязательно
scope:
  paths: ["src/**"]    # для path-scoped рендера в .claude/rules
evidence:              # citations, проверяются при валидации
  - { file: "package.json", anchor: "scripts.test" }
  - { session: "c1a2…", task: 3 }
status: active | proposed | stale | superseded
supersedes: [gk-12aa]
confidence: 0.85
source: analyzer | user | agent
created: 2026-10-21
last_validated: 2026-10-21
counters: { helpful: 2, harmful: 0, seen: 5 }   # локальное состояние, не в git
savings_estimate: { tool_calls: 6, tokens: 20000 }  # оценка анализатора, проверяется метриками
```

Контент лежит в git, а счётчики и `last_used` хранятся локально в `${CLAUDE_PLUGIN_DATA}/projects/<id>/state.json`. Так счётчики не создают шум в коммитах.

### 3.3. Хранилище в репозитории

```
.archivist/
  config.json                 # режимы, бюджеты, пороги
  ledger.jsonl                # append-only журнал операций (ADD/UPDATE/DEPRECATE…): источник истины, provenance
  decisions/ADR-0007-*.md     # рендер записей type=decision в формате ADR (читается по требованию)
  INDEX.md                    # однострочный индекс всех активных записей (для recall и человека)
  reports/2026-10-21T18-40-task-3.md
  proposals/                  # очередь на ревью
  .local/                     # в .gitignore: журналы сессий, кэш, lock-файлы
.claude/rules/archivist/
  core.md                     # без paths → грузится при старте: команды и топ-ловушки, ЖЁСТКИЙ бюджет (≈ 60 строк)
  db.md                       # paths: ["src/db/**"] → ленивая загрузка
  api.md                      # paths: ["src/api/**"]
.claude/skills/<procedure>/SKILL.md   # только после ревью: повторяющиеся процедуры
```

Принципы:
- Представления генерируются из ledger и не правятся руками. Ручная правка определяется по хэшу и превращается в операцию UPDATE с `source: user`.
- Корневые `CLAUDE.md` и `AGENTS.md` автоматически **не трогаются**. Предлагаем только однажды добавить строку `@.archivist/INDEX.md` или ничего, потому что rules уже загружаются, и делаем это через proposal.
- Порядок записей в `core.md` стабильный, файл обновляется пачкой в конце задачи. Это бережёт prompt cache следующих сессий.
- Сосуществование с нативной auto-memory: анализатор читает `MEMORY.md` и не дублирует его записи. Командой `archivist promote` полезные личные записи можно перенести в проектный ledger.

### 3.4. События мода: что и зачем

| Событие мода | Действие | Что идёт в контекст или пользователю |
|---|---|---|
| `session.start` | Регистрирует `/archivist:*` команды; проверяет stale (существуют ли файлы из evidence) через `$.fs.exists`; подбирает незабранный отчёт прошлой задачи; восстанавливает незавершённый анализ из `$.store` (переживает reload) | `$.ui.status("archivist: N записей · 3 на ревью")`. В контекст ничего: записи доставляют `.claude/rules/archivist/*` |
| `classic.UserPromptSubmit` / `turn.start` (главный цикл, без `agentId`) | Отмечает границу задачи; отменяет idle-таймер (сегмент продолжается); детектирует поправки и «remember:» эвристикой | Ничего |
| `classic.PostToolUse` / `classic.PostToolUseFailure` | Строка журнала: инструмент, путь или команда, `duration_ms`, размер ответа и ошибка (без содержимого) | — |
| `classic.InstructionsLoaded` | `load_reason: path_glob_match` + `trigger_file_path` дают счётчик `seen` для записи | — |
| `classic.PostCompact` / `session.compact` | Сохраняет `compact_summary`; перед компактом — checkpoint-анализ | — |
| `turn.complete` (главный цикл) | Добавляет `e.usage` и `durationMs` к метрикам сегмента; ставит idle-таймер `$.clock.after(idleSeconds)`. Тяжёлую работу внутри dispatch не делает | `{ text }`: строка под ответом с отчётом **прошлого** завершённого анализа или «📚 анализирую…» |
| `session.end` | Сохраняет сегмент в `$.store`/`$.fs` (бюджет 1.5 с), анализ доделывается при следующем `session.start` или CLI `archivist analyze` | — |

Защитные правила:
- Субагентские ходы (`e.agentId`) не считаются задачами, их метрики идут в задачу родителя.
- Ходы, начатые собственным `$.prompt.submit` (origin `plugin` = archivist), не анализируются, чтобы не было цикла.
- Каждый хук имеет `.catch(...)` → `next(e)`: fail-open.
- Журнал пишет один писатель (очередь в модуле). Конкурентные read+write через `$.fs` теряют записи, это проверено в спайке.
- Для запасного `claude -p`: `ARCHIVIST_CHILD=1`, `--settings '{"disableAllHooks":true}'`, `--no-session-persistence`.

### 3.5. Анализатор

- **Запуск LLM** (проверено в спайке, `docs/spikes.md` §7). Два вызова, оба на авторизации самой сессии:
  1. **Reflector: `$.model.fork({ prompt })`.** Короткий вопрос-извлечение поверх транскрипта сессии, весь префикс берётся из prompt cache. В спайке было 272k токенов cache read и 176 output за 4.6 с. Модель видит решения и рассуждения целиком, а не пересказ. Делается только для нетривиальных задач.
  2. **Curator: `$.model.complete({ model: 'haiku', system, prompt, maxTokens, timeoutMs })`.** На входе выход reflector'а, сигналы потерь и top-k существующих записей. Стабильная часть (`system`, правила формата) помечается `cache: true`. На выходе JSON с дельта-операциями.
  - Расход виден в `usage` каждого вызова и суммируется в отчёт и дневной бюджет. Лимиты подписки (`$.session.usage().rateLimits`) учитываются: если окно заполнено больше порога, анализ откладывается.
  - Запасной путь для CLI без сессии (`archivist analyze` из терминала, пакетный разбор старых транскриптов): `ARCHIVIST_CHILD=1 claude -p --model haiku --settings '{"disableAllHooks":true}' --no-session-persistence --tools "" --max-turns 1 --output-format json --json-schema schemas/ops.json`. Требует логина CLI или API-ключа.
- **Сегментация задачи.** Задача — это последовательность ходов от первого промпта после предыдущего анализа до простоя ≥ N секунд (по умолчанию 90), SessionEnd, PreCompact или явного `/archivist:done`.
- **Сигналы потерь** считаются детерминированно, до LLM:
  - число Read/Grep/Glob до первого Edit;
  - повторные чтения одного файла;
  - неудачная команда и затем успешная с другими аргументами (кандидат в `command`);
  - поправка пользователя (кандидат в `preference` или `convention`);
  - работа с файлом, у которого есть ловушка, но правило не загрузилось или было нарушено (повышает `harmful` и приоритет);
  - grep того, что уже есть в записи (re-discovery: запись неэффективна, переформулировать или сделать path-scoped).
- **Промпт reflector+curator** (один вызов): на входе дайджест, сигналы, top-k существующих записей, выдержки из README и CLAUDE.md для дедупа. На выходе JSON со списком операций. У каждой операции есть `evidence`, `confidence` и `savings_estimate`. В промпте явно запрещено писать overview и то, что выводится из кода.
- **Валидация** без LLM:
  - схема;
  - evidence существует;
  - дедуп по нормализованному тексту и BM25 против записей и существующих доков;
  - бюджеты: `core.md` не больше N строк, path-файл не больше M;
  - `confidence ≥ 0.8`, тип не `procedure`, не трогает чужие файлы → auto-apply, иначе в `proposals/`.
- **Идемпотентность.** Lock на проект, `processed` (session, сегмент) отмечается только после успешной записи.

### 3.6. Отчёт пользователю

Пример отчёта:

```
📚 Archivist · «добавить экспорт CSV» · 14 мин · 212k токенов · 23 Read/Grep до первой правки
Добавлено:
  + [command]  Тесты модуля: `pnpm vitest run src/export`             → rules/archivist/core.md
  + [gotcha]   src/db/**: миграции только через `pnpm db:gen`          → rules/archivist/db.md
  + [decision] ADR-0007 CSV стримингом, не в памяти (файлы > 1 GB)     → decisions/
  ~ [gotcha]   gk-12aa уточнено: env для e2e берётся из .env.test
  − [command]  gk-09bc устарела: скрипт `make build` удалён
На ревью (2): /archivist:review
Ожидаемая экономия на похожей задаче: ≈ −15 вызовов Read/Grep, ≈ −40k токенов
Анализ: haiku, 18k вход / 1.2k выход
```

Способы доставки задаются в `config.report.mode`. Все работают через mod и проверены в спайке:
1. **`quiet`** (по умолчанию, ноль токенов). Когда анализ готов:
   - `$.ui.status` с коротким итогом, он постоянно виден у поля ввода: «📚 +2 записи · 1 на ревью · /archivist:report»;
   - `$.ui.toast` с увеличенным `timeoutMs` как сигнал «готово»;
   - подробности идут в notice под следующим ответом (`turn.complete → { text }`; в десктопе это свёрнутый «Claude Code notice»), в файл `reports/` и в панель `/archivist:report` (`$.ui.open` + `ui.render`);
   - `$.ui.notify` в десктопе возвращает `no-surface`, поэтому используется только в терминале.
2. **`rewake`** (opt-in). `$.prompt.submit` с информационным текстом отчёта. Сессия получает ход сразу после анализа, и агент пересказывает итог. Стоит один короткий ход основной модели. Ходы с origin archivist анализом не охватываются, так что цикла нет.
3. Всегда: `/archivist:report [last|<id>]` и `archivist report` в терминале.

### 3.7. Сбор информации о проекте (холодный старт)

`archivist init`:
1. Детерминированно собирает команды из `package.json`, `Makefile`, `justfile`, `pyproject`, CI-конфигов и `docker-compose`. Создаёт черновики записей `command`. Обзоров не делает.
2. Индексирует существующие доки (README, CLAUDE.md, AGENTS.md, `docs/`) только для дедупа. В ledger они не копируются.
3. `archivist baseline` проходит по историческим транскриптам `~/.claude/projects/<proj>/*.jsonl`, считает baseline-метрики и (опционально, с подтверждением стоимости) извлекает из них кандидатов. Аналог `--scan-history` в claude-reflect.
4. Показывает план и стоимость, при первом запуске работает в dry-run (как `dryRunOnFirstUse`).

### 3.8. Метрики и проверка пользы

- На каждую задачу записываем:
  - input-токены (uncached и cache read отдельно) и output-токены;
  - длительность;
  - число Read/Grep/Glob до первого Edit;
  - повторные чтения;
  - неудачные команды;
  - число поправок пользователя;
  - какие записи загружены или процитированы.
- Источники: журнал хуков (стабильный API) и транскрипт. Транскрипт имеет внутренний формат, поэтому парсер толерантный, версионируется и покрыт тестами-фикстурами.
- `archivist stats` сравнивает с baseline по скользящему окну и показывает записи с `harmful > helpful` или без использования за 30 дней как кандидатов на удаление.
- Decay: запись без использования и без валидации ≥ 30 дней переходит в `stale` и исключается из рендера. Её можно восстановить.

### 3.9. CLI

```
archivist init | doctor | status
archivist hook <event>            # точка входа хуков (stdin JSON)
archivist analyze [--session S] [--segment N] [--dry-run]
archivist report [last|<id>]
archivist review                  # proposals: apply / edit / skip (TUI)
archivist recall <query>          # BM25 по записям; агент вызывает через Bash
archivist decide "<решение>" --why "<причина>"   # мгновенная запись ADR
archivist lint | gc               # противоречия, устаревшие evidence, бюджеты
archivist baseline | stats
archivist export --agents-md      # задел под другие агенты
```

### 3.10. Структура репозитория и стек

**Стек: TypeScript.**
- **Ядро** — чистый TS без Node-API: модели данных, merge, render, валидация, метрики, BM25. Весь I/O идёт через интерфейс `Io` (`read`, `write`, `exists`, `list`, `run`). Мод реализует `Io` на `$.fs`/`$.process`: в моде нет Node, но импорт своих файлов разрешён. CLI реализует его на `node:fs`.
- **Мод** — `hooks/register.ts`, тонкий адаптер. Для LLM есть интерфейс `Llm` (`reflect` → `$.model.fork`, `curate` → `$.model.complete`; в CLI — `claude -p`).
- **CLI** — Node ≥ 20, собирается esbuild в `plugin/bin/archivist` (один `.mjs`).
- Минимальная версия Claude Code — 2.1.290 (mods). Тесты мода — `claude plugin test` (`*.test.ts`), ядра — vitest.

```
archivist/
  src/
    core/        # агент-агностичное: entry, ledger, ops, merge, render, validate, metrics, recall, Io/Llm-интерфейсы
    analyzer/    # pipeline, digest, prompts, schemas/ops.json
    adapters/claude/
      mod/       # register.ts: события → журнал, idle-таймер, $.model.*, отчёт, команды, панель
      cli/       # claude -p runner, толерантный парсер JSONL (для baseline)
    cli/
  plugin/
    .claude-plugin/plugin.json
    hooks/hooks.json       # { "modules": ["./register.ts"] } (+ собранное ядро рядом)
    skills/{report,review,decide,remember,reflect}/SKILL.md
    bin/archivist          # собранный CLI
  .claude-plugin/marketplace.json
  test/fixtures/{transcripts,hook-payloads,session-messages,repos}/
  evals/<case>/{prompt.md,graders/*.md}   # claude plugin eval
```

Адаптерный интерфейс (`AgentAdapter`: события, `messages()`, `usage()`, `Llm`, `renderTargets`) закладываем сразу, хотя в v1 реализуется только Claude Code. Codex, Gemini CLI и Cursor тоже дают `transcript_path` и события конца хода, так что новые адаптеры будут тонкими: command-хуки и `-p`-раннер своего агента.

Запуск `plugin/bin/` в claude.ai и Cowork не поддерживается. Это ограничение принимаем для v1: целевые поверхности — терминал, десктоп и VS Code.

---

## 4. Конфигурация (`.archivist/config.json`)

```json
{
  "storage": "repo",                 // repo | local (всё в ${CLAUDE_PLUGIN_DATA})
  "analyzer": { "model": "haiku", "maxBudgetUsdPerTask": 0.05, "maxBudgetUsdPerDay": 1.0, "idleSeconds": 90,
                "minToolCalls": 5 },
  "apply": { "autoConfidence": 0.8, "autoTypes": ["command", "gotcha", "hotspot"], "neverTouch": ["CLAUDE.md", "AGENTS.md"] },
  "budgets": { "coreLines": 60, "pathFileLines": 40 },
  "report": { "mode": "next-turn", "desktopNotify": true },
  "privacy": { "redact": ["env", "tokens", "keys"], "excludePaths": [".env*", "secrets/**"] }
}
```

---

## 5. План работ по этапам

### Этап 0. Спайки ✅ выполнен 2026-10-21, итоги в `docs/spikes.md`

Главный итог: интеграция идёт через mod, а не через command-хуки и `claude -p`. Ниже исходный список вопросов.

Без этих проверок архитектуру не фиксируем:
1. `claude -p` с OAuth-подпиской, `--settings '{"disableAllHooks":true}'` и плагином в окружении. Проверить, что хуки плагина действительно отключены и рекурсии нет, и что `--no-session-persistence` не оставляет транскрипт.
2. Stop с `async: true` + `asyncRewake: true`. Как exit 2 доходит до Claude, не продолжает ли агент работу, сколько это стоит. Проверить, виден ли пользователю `systemMessage` из Stop и UserPromptSubmit.
3. Переживает ли detached-процесс, запущенный из SessionEnd, выход из Claude Code (`setsid` / `nohup`, вывод перенаправлен).
4. Фактический формат JSONL транскрипта на текущей версии: типы записей, `usage`, `tool_use` и `tool_result`, compaction. Снять фикстуры.
5. Payload `InstructionsLoaded`: можно ли по нему считать загрузку `.claude/rules/*` с `paths`.
6. Подхватываются ли изменения в `.claude/rules/` в середине сессии.
7. `monitors/` в плагине как возможный канал фоновых уведомлений.

**Результат**: `docs/spikes.md` с ответами и выбранный режим отчёта по умолчанию.

### Этап 1. MVP v0.1: работает end-to-end (≈ 1–1.5 недели)

**Статус на 2026-10-21: собран, первый живой прогон пройден.**
- Задача «README + отладка» (24 вызова инструментов) дала 10 применённых записей и 3 предложения. `core.md` занял 24 строки из 60.
- Записи по делу: ловушки валидатора и среды мода, неавторизованный `claude -p`, ADR с причинами. TODO-заметка («вернуть idleSeconds») правильно ушла на ревью, а не в базу.
- Стоимость одного анализа ≈ 50k взвешенных токенов. Почти всё — `fork` поверх контекста сессии (≈ 420k токенов из кэша).

Найдено и исправлено в прогоне:
- сегмент анализировался дважды после миграции ключа;
- reflect охватывал всю сессию, а не задачу;
- чтения через Bash (`cat`, `grep`, `sed -n`) не считались разведкой;
- curator повторял заголовок в `content` и склеивал два факта в одну запись;
- анализ не перепланировался после перезагрузки мода;
- не было диагностики: теперь есть `/archivist log`.

Открыто, переносится в этап 2:
- **Стоимость `fork` растёт с контекстом сессии.** Нужен порог по размеру контекста: выше него использовать `digest` и haiku.
- **Path-scoped рендер.** Ловушки со `scope` пока лежат в `core.md` с пометкой пути, а должны лежать в `.claude/rules/archivist/<area>.md`.
- **Язык записей смешанный:** команды из `init` по-английски, записи анализатора по-русски. Нужна настройка `language`.
- **Ревью предложений:** `/archivist review`.

- Каркас плагина с модом (`plugin.json`, `hooks.json → modules`), ядро на интерфейсах `Io`/`Llm`, fail-open (`.catch` на каждом хуке), лог в `.archivist/.local/log`.
- Журнал на `classic.PostToolUse`/`PostToolUseFailure`, `turn.start`/`turn.complete` (usage), один писатель.
- Сегментация, idle-таймер, сохранение незавершённого анализа в `$.store` на случай reload или `session.end`, lock-файлы, идемпотентность.
- Анализатор: digest из `$.session.messages()`, reflect через `$.model.fork`, curate через `$.model.complete` haiku с JSON-операциями. Типы только `command`, `gotcha`, `decision`.
- Ledger, merge, рендер `.claude/rules/archivist/core.md` и `decisions/`.
- Отчёт: файл, `next-turn` и `/archivist:report`.
- `archivist init` (только команды), `doctor`, `status`.
- Тесты: unit для merge и render, фикстуры payload, golden-тест анализатора на 3–5 записанных сессиях.

**Критерий готовности**: на реальном проекте после задачи появляется отчёт и 0–3 осмысленные записи. Тривиальная задача даёт NOOP. Рекурсии и зависаний нет, хуки укладываются в 100 мс.

### Этап 2. v0.2: качество и контроль (≈ 1 неделя)

**Статус на 2026-10-21: сделан** (тесты 25, валидатор плагина проходит). Что вошло:
- **Stale по evidence.** Записи, у которых все процитированные файлы исчезли, не попадают в правила и помечаются в `INDEX.md`. Ledger при этом не трогается, и запись возвращается сама, когда файл появится снова.
- **Path-scoped рендер.** Команды и ловушки со `scope.paths` лежат в `.claude/rules/archivist/<area>.md` с frontmatter `paths:` (бюджет 40 строк). Осиротевшие сгенерированные файлы удаляются, а файлы, написанные руками, не трогаются.
- **Ревью.** `/archivist review|apply|skip` и то же в CLI. Отклонённое запоминается в `.archivist/.local/skipped.jsonl`, и та же идея больше не предлагается.
- **Ручная запись.** `archivist add` и skills `/archivist:remember`, `/archivist:decide`. Решению обязателен `--why`.
- **Приватность.** Redaction секретов в журнале, в материале для модели и в записях. Запись с маскированием уходит на ревью. Пути из `privacy.excludePaths` не попадают никуда.
- **Из прогона этапа 1:**
  - порог `analyzer.forkMaxContextTokens` (300k): выше него reflect идёт по дайджесту, и причина пишется в отчёт;
  - настройка `language` для промптов и `init`;
  - id сессий больше не пишутся в коммитимые файлы, отчёты и предложения лежат в `.archivist/.local/`.

Не сделано из исходного списка, переносится:
- «edit» при ревью: пока это правка JSON предложения и затем `apply`;
- детекция поправок на `UserPromptSubmit` остаётся эвристикой в сигналах анализатора, отдельного хука нет.

- Валидация evidence, `stale`, дедуп против существующих доков, бюджеты рендера.
- Path-scoped рендер `.claude/rules/archivist/<area>.md` по `scope.paths`.
- Очередь proposals и `/archivist:review` с apply, edit и skip.
- Детекция поправок пользователя на UserPromptSubmit (эвристика, а финальное решение принимает анализатор).
- Redaction секретов, `privacy.excludePaths`.
- Skills `/archivist:decide`, `/archivist:remember`.

### Этап 3. v0.3: измерение и самокоррекция (≈ 1 неделя)

**Статус на 2026-10-21: сделан** (тесты 33, валидатор плагина проходит). Что вошло:
- **Метрики каждой задачи**, включая тривиальные: токены, вызовы, чтения до первой правки, повторные чтения, упавшие команды, поправки, длительность. Лежат в `.archivist/.local/metrics.jsonl`.
- **`archivist baseline`.** Транскрипты Claude Code этого проекта до первой записи Archivist разбираются в те же сегменты, что и в моде, и считаются тем же кодом. На этом репозитории: 7 задач из 1 сессии.
- **`archivist stats` и `/archivist stats`.** Сравниваются медианы последних 30 задач с baseline. Оценка экономии от анализатора сверяется с наблюдаемой: savings × число использований против разницы медиан. Есть таблица использования записей.
- **Атрибуция и счётчики** (`.archivist/.local/usage.json`):
  - `seen`: файл правил по путям загрузился (`InstructionsLoaded`);
  - `used`: задача выполнила записанную команду, или curator ответил `reinforce`;
  - `helpful`/`harmful`: reflect отвечает, какие записи из списка «в игре» помогли, а какие ввели в заблуждение (по ACE).
  - Запись, у которой `harmful ≥ 2` и `harmful > helpful`, один раз предлагается на удаление.
- **`archivist gc`** (decay): записи без признаков жизни за N дней. Решения не трогаются, это история.
- **`archivist lint`:** почти-дубли, противоречащие команды с одинаковым названием, stale, решения без причины, переполнение `core.md`, записи без ссылки на файл.
- **`archivist recall`** (BM25 с разбиением составных слов и обрезкой до основы) в CLI и `/archivist recall`. Подсказка про него стоит в шапке `core.md`.
- **Процедуры:** тип `procedure`. При первом появлении он запоминается, при повторе уходит на ревью, после `apply` превращается в skill `.claude/skills/archivist-<имя>/SKILL.md`.

Ограничения:
- «цитирование в ответах» реализовано через ответ reflect, а не через поиск текста записи в ответах агента;
- сравнение с baseline значимо только после 5+ задач с каждой стороны, и `stats` об этом предупреждает;
- задачи разного размера сравниваются медианами, без нормализации по сложности.

- Метрики на задачу, `archivist baseline` и `archivist stats`.
- Атрибуция использования (InstructionsLoaded, цитирование в ответах), счётчики helpful и harmful, decay, `gc`, `lint` (противоречия).
- `archivist recall` (BM25) в `bin/`.
- Предложения `procedure` в skill (только через ревью, после 2+ повторов).
- Оценка `savings_estimate` с ретроспективной проверкой по метрикам.

### Этап 4. v1.0: публикация (≈ 3–5 дней)

- `marketplace.json`, `claude plugin validate --strict`.
- Eval-кейсы `claude plugin eval`: «правильный NOOP», «ловушка зафиксирована», «нет цикла на Stop», «решение попало в ADR».
- README, раздел о стоимости и приватности, `archivist uninstall` (чистое удаление).
- Dogfooding на 2–3 своих проектах в течение недели, затем подстройка порогов.

### После v1

- Адаптеры для Codex CLI (`hooks.json`, Stop/SessionEnd), Gemini CLI (AfterAgent/SessionEnd), Cursor (stop/sessionEnd).
- Экспорт в AGENTS.md.
- Слой global: повышение записи до глобальной, если она встречается в 2+ проектах, ID проекта по git remote.
- Опциональный MCP-сервер для recall.
- Опциональная интеграция с индексатором кода (Serena, repo-map), если метрики покажут стабильный поиск одного и того же.

---

## 6. Риски и как их снять

| Риск | Митигирование |
|---|---|
| Анализатор тратит много токенов (опыт claude-mem) | Один вызов на задачу, пороги `minToolCalls`, бюджеты на задачу и на день, haiku, дайджест ≤ 15k, стоимость в каждом отчёте |
| Записи вредят: раздувают контекст, агент «исполняет всё» (ETH) | Жёсткие бюджеты `core.md`, запрет на overview, дедуп против доков, path-scoped ленивая загрузка, счётчик harmful и decay |
| Ложные или устаревшие факты | Evidence обязателен и валидируется, статусы stale и superseded, ревью для низкой уверенности, учёт исхода задачи (тесты прошли, правку откатили) |
| Формат транскрипта меняется | Основной источник — `$.session.messages()` и журнал хуков (документированный API). Парсер JSONL нужен только для `baseline`, он толерантный и покрыт фикстурами, `doctor` проверяет совместимость |
| Mods API новый и меняется (сейчас 2.1.290+, часть полей с 2.1.29x–2.1.304) | Мод — тонкий адаптер, вся логика в ядре. Используем только задокументированные методы. `claude plugin validate --strict` и `claude plugin test` в CI. В `doctor` проверяется версия. Запасной путь через CLI (`claude -p`) работает без мода |
| `$.model.fork` на длинной сессии дорогой: кэш-чтение всего контекста основной модели | Fork только для нетривиальных задач. Бюджет на задачу и на день, учёт `rateLimits`. Если кэш остыл (сессия простаивала дольше TTL), используем `complete` на haiku с дайджестом |
| Рекурсия и циклы на Stop | `ARCHIVIST_CHILD`, `disableAllHooks`, `stop_hook_active`, отчёт не содержит императивов, eval-кейс на цикл |
| Хуки тормозят сессию | Синхронные хуки только I/O с бюджетом меньше 100 мс, всё остальное async или detached, бандл без зависимостей |
| Утечка секретов в репозиторий | Redaction до LLM и до записи, `excludePaths`, без телеметрии, без облака |
| Конфликты в git у команды | ledger append-only (конфликты тривиальны), представления генерируются заново, `archivist render` после merge |

---

## 7. Принятые решения (2026-10-21)

1. **Стек:** TypeScript. Ядро на чистом TS, адаптер — mod Claude Code, CLI на Node.
2. **Хранение:** в репозитории (`.archivist/`, `.claude/rules/archivist/`), счётчики локально.
3. **Автономия:** автоприменение при `confidence ≥ 0.8` для `command`/`gotcha`/`hotspot` в собственных файлах. Всё остальное через ревью.
4. **Модель:** `$.model.fork` (reflect) и `$.model.complete` haiku (curate) на авторизации сессии; `claude -p` только как запасной путь.
5. **Отчёт:** `quiet` по умолчанию (toast, статус, строка под следующим ответом, панель), `rewake` по opt-in.

---

## Источники

- Claude Code: [hooks](https://code.claude.com/docs/en/hooks), [plugins manifest](https://code.claude.com/docs/en/plugins/manifest-reference), [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [headless](https://code.claude.com/docs/en/headless), [statusline](https://code.claude.com/docs/en/statusline)
- Исследования:
  - [ACE (arXiv 2510.04618)](https://arxiv.org/html/2510.04618)
  - [Dynamic Cheatsheet (2504.07952)](https://arxiv.org/html/2504.07952)
  - [mem0 (2504.19413)](https://arxiv.org/html/2504.19413)
  - [Zep/Graphiti (2501.13956)](https://arxiv.org/html/2501.13956)
  - [Agent Workflow Memory (2409.07429)](https://arxiv.org/abs/2409.07429)
  - [Evaluating AGENTS.md (2602.11988)](https://arxiv.org/html/2602.11988v1)
  - [AGENTS.md efficiency (2601.20404)](https://arxiv.org/html/2601.20404v2)
  - [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Продукты: [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory), [Cline Memory Bank](https://docs.cline.bot/prompting/cline-memory-bank), [agents.md](https://agents.md/), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/), [Cursor hooks](https://cursor.com/docs/hooks), [ccusage](https://github.com/ryoppippi/ccusage)
- Репозитории из таблицы в п. 1.1.
