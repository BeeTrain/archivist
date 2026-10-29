---
name: panel
description: Open the live Archivist panel with entry counts, saved records and proposals awaiting review beside the chat.
---

Resolve the plugin root from this file. Start `node "<plugin-root>/bin/archivist" panel --root "<project-root>"` as a persistent terminal process. The command prints a loopback URL with a random access token; keep that process running while the panel is in use. Do not put this URL into committed files.

Open the printed URL beside the chat using the app's browser panel tool if available. Otherwise provide the URL for the user to open. Reuse an already running panel for this project when its URL is known and it responds. The panel refreshes from the project's ledger and proposal queue every three seconds. It only reads data. Use the triage skill when the user asks to resolve proposals; viewing the panel is not approval to apply them. Stop the process when the user asks to close it.
