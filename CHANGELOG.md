# Changelog

## 1.3.3 — 2026-10-22

- Only knowledge of the project: the curator no longer proposes the setup of the user's machine or accounts (dotfiles, global git config, shell, credentials), facts about other repositories, or what tools already enforce without the agent (git config, hooks, linters, CI).
- `/archivist:triage` skips such proposals itself, decisions included, instead of asking the user; `remember` and `decide` decline them with a one-line reason.

## 1.3.2 — 2026-10-22

- Fix: the status line kept showing an old review count after the queue was settled through the CLI (the triage skill, `archivist apply`/`skip`): the mod repeated the text it had set instead of counting again. It now recounts entries and the queue at the end of every turn and when an app attaches. "analysing", "postponed" and "failed" stay until the next analysis replaces them.

## 1.3.1 — 2026-10-22

- core.md gets a character budget (`budgets.coreChars`, 6000 ≈ 2k tokens) besides its line budget, and path-scoped files one too (`budgets.pathFileChars`, 3000). Lines alone let long entries grow core.md to ~10k characters.
- What fits is chosen by merit (used, seen, helpful; misleading last), then commands, gotchas, decisions; it is written in a stable order. The rest stays in INDEX.md and `recall`.
- Decisions scoped to paths go, in full, to that area's rule file instead of core.md. In core.md a decision is its title and first sentence (`rules.decisions: "full"` restores the whole text).
- The curator is asked to scope decisions to paths and to open each with the rule in one sentence.
- `health` and `doctor` report characters against the budgets. On this project core.md went from 10,062 to 4,163 characters with every entry still in a rule file.

## 1.3.0 — 2026-10-22

- `/archivist health` and `archivist health`: one look at how Archivist is doing in a project — the knowledge base, the last week of analyses (done, skipped, failed, postponed, cost), entries no task met, entries judged wrong, lint findings — ending in what to do, or that nothing needs doing.
- Every analysis run is recorded in `.archivist/.local/analyses.jsonl` (outcome, entries recorded, cost, errors).

## 1.2.2 — 2026-10-22

- Fix: in a project where `archivist init` never ran, `.archivist/.local/` (reports quoting prompts and session ids) was not git-ignored. Every writer now creates `.archivist/.gitignore`, or adds a `.local/` line to an existing one, before its first write under `.archivist/`.
- The mod keeps one diagnostic log per project; `/archivist log` shows the current project's.

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
