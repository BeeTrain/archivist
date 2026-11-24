---
name: archivist-collection
description: Inspect Antigravity hook delivery, event counts, and background analysis queue status for Archivist.
---

Inspect Archivist event collection and background analysis status in the current project. Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set):

```bash
node "<plugin-root>/bin/archivist" collection
node "<plugin-root>/bin/archivist" analysis status
```

If the user asks to toggle or trigger background analysis:
- Enable: `node "<plugin-root>/bin/archivist" analysis enable`
- Disable: `node "<plugin-root>/bin/archivist" analysis disable`
- Process due queue immediately: `node "<plugin-root>/bin/archivist" analysis run`
