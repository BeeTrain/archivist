---
description: Record a fact about this project for future sessions with Archivist — an exact command or a non-obvious pitfall. Use when the user says "remember", "запомни", "note for next time", or corrects a command or approach that should stick.
argument-hint: "[what to remember]"
---

Record one fact the next sessions in this project should know, as an Archivist entry.

What to remember: $ARGUMENTS (if empty, take it from the conversation: the last correction or discovery the user wants kept).

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
"${CLAUDE_PLUGIN_ROOT}/bin/archivist" add --type gotcha --title "<title>" --content "<content>" [--paths "src/db/**"] [--evidence "<file>"]
```

6. Tell the user in one line what was recorded and where it will show up (`.claude/rules/archivist/`). If the tool answered that it reinforced an existing entry, say that instead.
