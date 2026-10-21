---
description: Record an architecture or design decision for this project as an ADR with Archivist — what was chosen, why, and what was rejected. Use when the user and agent settle on an approach that later sessions should follow, or the user asks to record a decision.
argument-hint: "[the decision]"
---

Record one decision as an Archivist ADR, so later sessions follow it instead of reopening it.

The decision: $ARGUMENTS (if empty, take it from the conversation: the approach just agreed on).

1. State it:
   - title: at most 8 words, the choice itself ("Stream CSV exports", not "CSV discussion");
   - content: 1–2 imperative lines saying what to do;
   - why: the reason, and the alternatives that were rejected and why. A decision without a reason is not recorded.
2. Scope it with `--paths` if it concerns only part of the code; cite the main file with `--evidence`.
3. Run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/archivist" add --type decision --title "<title>" --content "<content>" --why "<reason; rejected alternatives>" [--paths "<glob>"] [--evidence "<file>"]
```

4. Tell the user in one line which ADR was written (`.archivist/decisions/ADR-…`). If the decision replaces an earlier one, say which, so it can be marked superseded.
