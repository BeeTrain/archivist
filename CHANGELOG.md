# Changelog

## 1.2.1 — 2026-10-22

- Fix: a skill directory emptied by a rename or removal is removed too, including one left by an earlier version; a directory holding a file someone added stays.
- Fix: a procedure skill's description is its title and its "when to use" sentence, without a forced English "Use when" prefix.

## 1.2.0 — 2026-10-22

- `/archivist:triage`: the agent checks technical proposals against the code and settles them, asking the user only about decisions and removals, in plain words.
- Repeat promotes: a command or gotcha proposed again while its first proposal waits is applied (`review.promoteOnRepeat`). Decisions, procedures and anything with a masked secret still wait for a person.
- Unreviewed proposals expire after 14 days or 20 analysed tasks (`review.expireDays`, `review.expireTasks`), so an ignored queue stays small.
- `archivist review --json` and stable proposal ids for `apply`/`skip`.

## 1.1.2 — 2026-10-22

- Dedupe catches paraphrases: similarity over word stems (thresholds measured on duplicates the analyzer let through), across a command and a gotcha stating the same fact; two commands that run different code stay apart.
- Dedupe against the docs: a fact covered by three consecutive lines of CLAUDE.md, AGENTS.md or README, or a command whose every code span the docs already spell out, is dropped.
- The curator no longer proposes temporary state or to-dos.
- `edit`/`deprecate` report removed files separately from written ones.

## 1.1.1 — 2026-10-22

- Fix: the notice under the next answer repeated the whole answer before Archivist's summary; it now holds the summary only.
- Fix: the status line set at session start was lost when the app attached later; it is shown again on `session.attach` and after every turn.

## 1.1.0 — 2026-10-22

- `archivist edit <id>` and `archivist deprecate <id> --reason …`, and the same as `/archivist edit|deprecate`: fix or retire what is already recorded. An empty `--paths` clears an entry's scope.
- The curator no longer records one-off operations a task already finished (repo setup, credentials, commit rewrites).

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
