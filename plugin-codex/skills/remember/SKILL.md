---
name: remember
description: Record a fact about this project for future sessions with Archivist — an exact command or a non-obvious pitfall. Use when the user says "remember", "запомни", "note for next time", or corrects a command or approach that should stick.
argument-hint: "[what to remember]"
---

Record one fact the next sessions in this project should know, as an Archivist entry.

What to remember: the user’s request (if empty, take it from the conversation: the last correction or discovery the user wants kept).

Record only facts about this project that will still hold in later sessions. The setup of the user's machine or accounts (dotfiles, global git config, shell, credentials), another repository, or something a tool already enforces without the agent (git config, hooks, linters, CI) is not project knowledge either: do not record it, and say in one line why. Something personal, temporary or one-off ("I'm working from home today", "skip the tests this time") is not project knowledge: do not record it, and say in one line why. Never record a secret: write the variable name, not its value.

1. Decide the type:
   - `command`: an exact command to build, test, run, generate, deploy.
   - `gotcha`: a pitfall or non-obvious constraint, and how to avoid it.
   - A choice with a reason (we use X, not Y, because…) is a decision: use the `decide` skill instead.
2. Write it the way it will be read at the start of every session:
   - title: at most 8 words naming the fact;
   - content: 1–2 imperative lines, concrete (exact command, path, flag), not repeating the title;
   - only what cannot be quickly derived from the code; no secrets.
3. If it only matters for some files, scope it with `--paths` (globs, comma-separated): it then loads only when those files are touched.
4. Cite the file it is backed by with `--evidence` when there is one.
5. Run:

```bash
"${PLUGIN_ROOT}/bin/archivist" add --type gotcha --title "<title>" --content "<content>" [--paths "src/db/**"] [--evidence "<file>"]
```

6. Tell the user in one line what was recorded and where it will show up (`.archivist/codex/rules/`). If the tool answered that it reinforced an existing entry, say that instead.

Resolve the installed plugin root from this skill’s location (two directories above its folder). Use that absolute path if PLUGIN_ROOT is not present in the shell. Do not guess the cache path.
