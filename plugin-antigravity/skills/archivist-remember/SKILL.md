---
name: archivist-remember
description: Record a verified project command or non-obvious gotcha into Archivist's knowledge base.
---

Record a reusable project command or gotcha via the Archivist CLI (never edit `.archivist/` files by hand). Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set):

```bash
node "<plugin-root>/bin/archivist" add \
  --type <command|gotcha> \
  --title "<short title>" \
  --content "<exact command or 1-3 concise imperative lines>" \
  [--paths "<glob,glob>"] \
  [--evidence "<file,file>"]
```

Only record facts that outlive the current task and apply to this repository (never personal dotfiles, secrets, or one-off ticket notes).
