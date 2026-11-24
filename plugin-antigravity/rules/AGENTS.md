# Archivist

This workspace may use **Archivist** (`.archivist/`) to store verified project commands, gotchas, and architectural decisions (ADRs).

- Before broad codebase exploration, check if `.archivist/` exists and use the `archivist-recall` skill or run `archivist recall <words>`.
- Never edit `.archivist/ledger.jsonl`, `.archivist/INDEX.md`, `.archivist/decisions/`, or `.archivist/antigravity/rules/` by hand — always go through the Archivist CLI (`add`, `edit`, `deprecate`, `apply`, `skip`, `render`) or its UI panel.
- When the user wants to inspect knowledge, review proposals, or check reports visually, offer the side panel link `[Archivist](sidecar://archivist/archivist_panel/)`.
