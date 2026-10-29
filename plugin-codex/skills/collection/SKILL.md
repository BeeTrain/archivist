---
name: collection
description: Inspect Archivist Codex event collection and capture durable lessons from the current task.
---

Inspect local collection health using `node "<plugin-root>/bin/archivist" collection` from the project directory. Resolve plugin-root from this file. Report observed event counts and missing events, distinguishing an untested path from a failure. The collector records metadata only, not prompt or tool-result contents. No automatic model analysis is enabled. For learning from the current task, inspect the conversation and verified code, and use remember or decide to record only durable project facts. Use triage for pending proposals. Do not invent conclusions from event counts.
