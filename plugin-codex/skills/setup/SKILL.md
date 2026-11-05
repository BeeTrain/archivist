---
name: setup
description: Set up Archivist for Codex in a project.
---

Set up Archivist in the current project. Resolve this plugin root from this skill file. Run `node "<plugin-root>/bin/archivist" init`, then `node "<plugin-root>/bin/archivist" doctor`. Explain that lifecycle hooks must be enabled and trusted in Codex. Start a new chat and run collection to verify SessionStart delivery. Knowledge lives in .archivist; generated procedures live in .agents/skills.

Background analysis is opt-in. When the user asks to enable it, run `node "<plugin-root>/bin/archivist" analysis enable` from the project directory. It captures a bounded, redacted task digest and calls the installed Codex CLI with its existing login after idle time; those calls use the account's usage. All knowledge changes go to review. No separate API key is required. Use `analysis status` to inspect the queue and `analysis disable` to stop further analysis without removing saved data. Do not enable background capture as part of ordinary initialization unless the user requested it.
