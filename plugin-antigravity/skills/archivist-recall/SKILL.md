---
name: archivist-recall
description: Search Archivist's project knowledge base (commands, gotchas, ADRs) before exploring the codebase.
---

Search recorded project knowledge before reading many files or guessing commands. Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set):

```bash
node "<plugin-root>/bin/archivist" recall <keywords>
```

Use the matching entries to guide your work. If an entry turns out to be outdated or wrong, tell the user and offer to update or deprecate it with `edit` / `deprecate`.
