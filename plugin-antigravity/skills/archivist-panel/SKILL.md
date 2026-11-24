---
name: archivist-panel
description: Open the live Archivist UI panel in Antigravity's Auxiliary Side Pane to browse entries, search knowledge, accept/skip review proposals, and view reports.
---

Open the live Archivist side panel for the current project.

1. Resolve `<plugin-root>` as two directories above this skill file (or `$PLUGIN_ROOT` if set) and register the current workspace so the panel focuses it automatically:

```bash
node "<plugin-root>/bin/archivist" register
```

2. Call the `archivist_panel` MCP tool (pass the current project root if known) to open the live Archivist MCP App panel. The user can also open **Archivist** anytime from the right side pane menu (`+` / new tab) or from the left sidebar.

3. If the user specifically asks for a standalone browser URL in the terminal instead of the Antigravity side pane, mention `node "<plugin-root>/bin/archivist" panel`.
