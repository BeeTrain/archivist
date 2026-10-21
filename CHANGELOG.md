# Changelog

## 1.0.0 — 2026-10-21

- Published as a Claude Code marketplace: `/plugin install archivist --marketplace BeeTrain/archivist`.
- The built plugin (`plugin/hooks/register.js`, `plugin/bin/archivist`) is committed; CI checks it is current.
- `archivist uninstall [--purge]`: removes what Archivist generated, never a hand-written file.
- Eval suite (`plugin/evals/`): pitfall recorded and scoped, decision as ADR, personal facts declined, secrets masked.
- The remember skill declines personal or temporary facts and never records secret values.

## 0.3.0

- Per-task metrics, `archivist baseline` from earlier transcripts, `archivist stats` against it.
- Usage counters per entry (seen, used, helpful, harmful); misleading entries proposed for removal.
- `archivist gc`, `archivist lint`, `archivist recall`; procedures become skills after a repeat and a review.

## 0.2.0

- Stale entries, path-scoped rule files, review (`apply`/`skip`), manual entries and the remember/decide skills.
- Secret redaction and `privacy.excludePaths`; reflection falls back to a digest above `forkMaxContextTokens`.

## 0.1.0

- MVP: task journal in a Claude Code mod, reflect (`$.model.fork`) and curate (haiku), ledger, rules, ADRs, reports.
