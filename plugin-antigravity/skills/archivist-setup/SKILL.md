---
name: archivist-setup
description: Set up Archivist in the current project, seed build/test/lint commands, verify with doctor, and register the workspace for the Archivist UI panel.
---

Set up Archivist in the current project. Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set).

1. Run initialization and registration:

```bash
node "<plugin-root>/bin/archivist" init
node "<plugin-root>/bin/archivist" doctor
```

2. Explain concisely:
   - Shared knowledge lives in `.archivist/ledger.jsonl`, `.archivist/INDEX.md`, and `.archivist/decisions/`.
   - Antigravity-specific rendered rules live in `.archivist/antigravity/rules/` and generated procedures in `.agents/skills/`.
   - Open the live UI panel in the right Auxiliary Pane via [Archivist](sidecar://archivist/archivist_panel/).
   - Background analysis is opt-in: enable it with `node "<plugin-root>/bin/archivist" analysis enable` (or directly in the UI panel). It uses `agy` CLI in print mode (`agy -p`) and sends all changes to the review queue.
