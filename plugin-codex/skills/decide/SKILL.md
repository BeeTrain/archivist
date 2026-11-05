---
name: decide
description: Record an architecture or design decision for this project as an ADR with Archivist — what was chosen, why, and what was rejected. Use when the user and agent settle on an approach that later sessions should follow, or the user asks to record a decision.
argument-hint: "[the decision]"
---

Record one decision as an Archivist ADR, so later sessions follow it instead of reopening it.

The decision: the user’s request (if empty, take it from the conversation: the approach just agreed on).

Only decisions about this project. A choice about the user's machine or accounts (global git config, dotfiles, shell), another repository, or something a tool already enforces without the agent is not one: do not record it, and say in one line why.

1. State it:
   - title: at most 8 words, the choice itself ("Stream CSV exports", not "CSV discussion");
   - content: 1–2 imperative lines saying what to do;
   - why: the reason, and the alternatives that were rejected and why. A decision without a reason is not recorded.
2. Scope it with `--paths` if it concerns only part of the code; cite the main file with `--evidence`.
3. Run:

```bash
"${PLUGIN_ROOT}/bin/archivist" add --type decision --title "<title>" --content "<content>" --why "<reason; rejected alternatives>" [--paths "<glob>"] [--evidence "<file>"]
```

4. Tell the user in one line which ADR was written (`.archivist/decisions/ADR-…`). If the decision replaces an earlier one, say which, so it can be marked superseded.

Resolve the installed plugin root from this skill’s location (two directories above its folder). Use that absolute path if PLUGIN_ROOT is not present in the shell. Do not guess the cache path.
