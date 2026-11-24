---
name: archivist-triage
description: Review and settle Archivist's pending proposals — verify technical items against the codebase yourself and ask the user only about decisions and removals.
---

Settle Archivist's review queue for the current project. Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set).

1. Fetch the queue with stable IDs:

```bash
node "<plugin-root>/bin/archivist" review --json
```

If empty, say so in one line and stop.

2. For items with `"human": false` (commands, gotchas, procedures, updates):
   - Verify against the codebase (scripts exist, referenced files/symbols exist, not already documented or duplicated via `recall`).
   - Apply verified lasting items (`node "<plugin-root>/bin/archivist" apply <id>`) or skip invalid/temporary ones (`node "<plugin-root>/bin/archivist" skip <id>`).

3. For items with `"human": true` (decisions, deprecations):
   - Skip anything unrelated to this project first.
   - Ask the user about the remaining items in one short message in plain words (no raw IDs), then apply or skip according to their reply.

4. Summarize what was applied, skipped, and what remains (or remind them they can also review proposals visually in [Archivist](sidecar://archivist/archivist_panel/)).
