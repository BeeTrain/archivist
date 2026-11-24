---
name: archivist-decide
description: Record an agreed architectural decision as an ADR in Archivist (with rationale and rejected alternatives).
---

Record a project decision as an ADR via the Archivist CLI (never edit `.archivist/` files by hand). Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set):

```bash
node "<plugin-root>/bin/archivist" add \
  --type decision \
  --title "<short decision title>" \
  --content "<what was decided>" \
  --why "<why this option was chosen and what alternatives were rejected>" \
  [--paths "<glob,glob>"] \
  [--evidence "<file,file>"]
```

`--why` is mandatory for decisions.
