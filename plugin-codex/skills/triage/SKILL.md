---
name: triage
description: Work through Archivist's review queue for the user — check technical proposals against the code and settle them yourself, and ask the user only about decisions and removals, in plain words. Use when the user asks to review, triage or clean up Archivist proposals, or the status line shows proposals to review.
---

Settle Archivist's review queue so the user does not have to read it. The user decides only what is theirs to decide.

1. Get the queue with stable ids:

```bash
"${PLUGIN_ROOT}/bin/archivist" review --json
```

If it is empty, say so in one line and stop.

2. Items with `"human": false` (commands, gotchas, procedures, updates) are yours. For each, check it against the project before deciding:
   - a command: the script, target or binary exists (`package.json`, `Makefile`, the files it names); do not run anything that changes state;
   - a pitfall or update: the files and symbols it names exist and the code agrees with it (Read, Grep);
   - a procedure (it becomes a skill): the steps are correct and the workflow is one that recurs.

   If it is tied to the task at hand (a ticket number like `ABC-123`, a branch of the current work, an epic), it will be wrong once that task is done: keep only the part that outlives the task. Apply it, then rewrite it without the ticket with `"${PLUGIN_ROOT}/bin/archivist" edit <entry id> --title "…" --content "…"`; if nothing outlives the task, skip it.

   Apply it when it is true, still holds, and would save a future task time. Skip it when it is wrong, a one-off already done, temporary or a to-do, not about this project (see 3), already in the project docs, or already recorded (`"${PLUGIN_ROOT}/bin/archivist" recall <words>`). When you cannot tell, skip it: a fact that matters comes up again, and a repeat records it on its own.

   Act by id, one at a time:

```bash
"${PLUGIN_ROOT}/bin/archivist" apply <id>
"${PLUGIN_ROOT}/bin/archivist" skip <id>
```

3. Before asking anything, skip yourself, decisions included, whatever is not knowledge of this project: the user's machine or accounts (dotfiles, global git config, shell setup, credentials), another repository, or something a tool already enforces without the agent (a git `includeIf`, a hook, a linter, CI). Say in one line per kind why you skipped them. The test: would an agent working in this project act differently because of it?

4. The remaining items with `"human": true` (decisions, removals) are the user's. Do not act on them yet. Ask about all of them in one message, one short line each, in plain words, without ids or jargon. For example:
   - "Записать решение: документацию пишем на русском, потому что остальная документация на русском. Да?"
   - "Убрать запись «Сборка не коммитится»: она устарела, с версии 1.0 сборка коммитится. Да?"

   A decision tied to the task at hand is offered only in its lasting form, rephrased without the ticket or branch: "Записать решение: агент не пушит, PR открываешь ты. Да?" On a yes, apply it and rewrite it the same way with `edit`.

   Then apply or skip each by the answer. No answer means leave it: unreviewed proposals expire on their own.

5. Finish with one short summary: how many you applied and skipped (and the main reason for skipping), and what waits for the user.

Change the knowledge base only through these commands: never edit `.archivist/` or `.archivist/codex/rules/` by hand.

Resolve the installed plugin root from this skill’s location (two directories above its folder). Use that absolute path if PLUGIN_ROOT is not present in the shell. Do not guess the cache path.
