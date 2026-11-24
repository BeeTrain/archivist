# Archivist для Antigravity

Нативный плагин **Archivist** для Google Antigravity с UI-панелью в правой вспомогательной панели (Auxiliary Pane), lifecycle hooks, навыками и полной поддержкой консольных команд. Использует общую базу `.archivist/` с версиями для Claude Code, Codex и OpenCode.

## Что входит в плагин

- **UI-панель (`sidecars/archivist_panel/`)**:
  - Нативная вкладка в правой панели Antigravity (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) с авто-синхронизацией светлой/тёмной темы.
  - Переключение проектов и добавление пути к проекту, инициализация `.archivist/` в один клик.
  - Поиск и фильтрация записей по типам (`command`, `gotcha`, `decision`, `procedure`), добавление новых записей и вывод устаревших (`deprecate`).
  - Интерактивная очередь ревью: принятие (`apply`) и отклонение (`skip`) предложений прямо из UI с защитой по fingerprint.
  - Просмотр отчётов, метрик сбора хуков и кнопки `render` / `lint`.
- **Lifecycle Hooks (`hooks.json`)**:
  - `SessionStart` — регистрирует проект для UI-панели, пересобирает `.archivist/antigravity/rules/` и подставляет `core.md` в сессию через `injectSteps`.
  - `PreInvocation` / `PostToolUse` / `Stop` — собирают очищенные метаданные и (при включённом анализе) дайджест задачи в `.archivist/.local/antigravity/`.
- **Фоновый анализ**:
  - Опциональный (выключен по умолчанию, включается через UI или `analysis enable`).
  - Использует `agy --output-format json --disable-slash-commands --json-schema ... -p ...`; все изменения идут в очередь ревью.
- **Навыки (`skills/`)**:
  - `archivist-setup`, `archivist-panel`, `archivist-recall`, `archivist-remember`, `archivist-decide`, `archivist-triage`, `archivist-collection`.

## Подключение

В корне репозитория Archivist:

```bash
npm run build
npm run validate:antigravity
```

Подключение глобально в Antigravity (симлинк на собранный пакет):

```bash
ln -s /absolute/path/to/archivist/plugin-antigravity ~/.gemini/config/plugins/archivist
```

## Консольные команды

Все стандартные команды Archivist + команды Antigravity доступны через `plugin-antigravity/bin/archivist` (или `plugin/bin/archivist --target antigravity`):

```bash
archivist init [--root <dir>]
archivist status
archivist recall <запрос>
archivist add --type <command|gotcha|decision|procedure> --title "…" --content "…" [--why "…"] [--paths "…"]
archivist edit <id> [--title "…"] [--content "…"] [--why "…"] [--paths "…"]
archivist deprecate <id> --reason "…"
archivist review [--json]
archivist apply <n|id|all>
archivist skip <n|id|all>
archivist report [file]
archivist health | stats | lint | gc | render | doctor
archivist panel [--root <dir>]
archivist collection [--root <dir>]
archivist analysis [status|enable|disable|run] [--root <dir>]
archivist register [--root <dir>]
archivist uninstall [--purge]
```
