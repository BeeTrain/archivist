---
name: collection
description: Inspect Archivist Codex event collection and capture durable lessons from the current task.
---

Inspect local collection health using `node "<plugin-root>/bin/archivist" collection` and `node "<plugin-root>/bin/archivist" analysis status` from the project directory. Resolve plugin-root from this file. Report observed event counts, analysis state and missing events, distinguishing an untested path from a failure. With background analysis off, the collector records metadata only. With it enabled, a bounded, redacted task digest is stored locally and passed to a separate Codex CLI call; all proposed knowledge changes require review. Do not infer success from event counts alone.

For learning from the current task, inspect the conversation and verified code, and use remember or decide to record only durable project facts. Use triage for pending proposals. Use `analysis run` to resume a pending queue when requested; retries normally happen after fifteen minutes, with at most three attempts per task.
