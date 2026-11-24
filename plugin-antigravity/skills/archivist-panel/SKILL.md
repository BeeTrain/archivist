---
name: archivist-panel
description: Open the live Archivist UI panel in Antigravity's Auxiliary Side Pane to browse entries, search knowledge, accept/skip review proposals, and view reports.
---

Open the live Archivist side panel for the current project.

1. Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set) and register the current workspace so the panel focuses it automatically:

```bash
node "<plugin-root>/bin/archivist" register
```

2. Offer the one-click pill to open the panel in the right Auxiliary Pane:

[Archivist](sidecar://archivist/archivist_panel/)

3. If the user specifically asks for a standalone browser URL in the terminal instead of the Antigravity side pane, mention `node "<plugin-root>/bin/archivist" panel`.
