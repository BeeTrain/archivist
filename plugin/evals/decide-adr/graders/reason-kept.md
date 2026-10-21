---
type: llm
focus: { source: file, path: .archivist/ledger.jsonl }
---

PASS if the ledger records a decision (type "decision") to stream the CSV export, and its rationale says why: exports exceed 1 GB, and buffering in memory was rejected.
FAIL if there is no decision entry, or the rationale is missing or does not mention the size or the rejected buffering.
