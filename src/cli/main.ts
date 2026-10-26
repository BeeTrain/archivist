// archivist CLI: the terminal side of the plugin. The Claude Code mod does the per-task work; this sets a
// project up, records and reviews knowledge by hand, and checks the setup.
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, loadConfig } from "../core/config.js";
import { PATHS, type Io } from "../core/io.js";
import { activeEntries, appendLedger, loadState } from "../core/ledger.js";
import { withLock } from "../core/lock.js";
import { findStale, renderAll } from "../core/render.js";
import { commaList, parseOptions } from "../core/args.js";
import { addEntry, applyProposals, deprecateEntry, editEntry, editFromOptions, listProposals, pick, reviewJson, reviewText, skipProposals } from "../core/review.js";
import { ENTRY_TYPES, type EntryType } from "../core/types.js";
import { validateOps, type Outcome } from "../core/validate.js";
import { computeSignals } from "../analyzer/signals.js";
import { readProjectSegments, transcriptDir } from "../adapters/claude/cli/transcript.js";
import { gcCandidates, gcRecords, healthText, lint, recallText, statsText } from "../core/maintenance.js";
import { loadMemoryCaches } from "../core/memory.js";
import { BASELINE, compareText, summarize, toMetrics, type Baseline } from "../core/metrics.js";
import { findRoot, nodeIo, uninstall } from "./node-io.js";
import { scanCommands } from "./scan.js";

const HELP = `archivist — project knowledge from coding-agent sessions

Usage: archivist <command> [--root <dir>]

  init                  set up .archivist/ and seed exact build/test/lint commands from the project's manifests
  status                what is recorded: entries by type, proposals waiting for review
  report [file]         print the latest task report, or the given one
  review [--json]       list the proposals waiting for review (--json: with stable ids, for the triage skill)
  apply <n|id|1,3|all>  record proposals as they are
  skip <n|id|1,3|all>   drop proposals; the same idea is not proposed again
  add --type <command|gotcha|decision|procedure> --title <t> --content <c> [--why <reason>] [--paths <glob,glob>] [--evidence <file,file>]
                        record a fact by hand (decisions need --why)
  edit <id> [--title <t>] [--content <c>] [--why <reason>] [--paths <glob,glob>|--paths ""]
                        fix a recorded entry; an empty --paths makes it apply everywhere
  deprecate <id> --reason <why>
                        retire an entry: it leaves the rules, the ledger keeps it with the reason
  recall <words>        the recorded entries that match: ask this before exploring
  baseline [--before <date>]
                        measure the project's Claude Code sessions before Archivist (from their transcripts)
  stats                 recent tasks against the baseline, and how each entry fares
  health                one look at how Archivist is doing here, and what to do about it
  gc [--days 60] [--apply]
                        entries with no sign of use for that long; --apply retires them
  lint                  near-duplicates, contradictions, stale entries, decisions without a reason, budgets
  render                regenerate the rule files, index and ADRs from the ledger
  doctor                check the setup
  uninstall [--purge]   remove what Archivist generated (rules, skills); --purge also removes .archivist/
`;

const MIN_CLAUDE = [2, 1, 290];

const now = (): string => new Date().toISOString();

const readDocs = async (io: Io): Promise<string[]> => {
  const out: string[] = [];
  for (const p of ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "README.md"]) {
    const t = await io.read(p);
    if (t) out.push(t);
  }
  return out;
};

const printOutcomes = (outcomes: Outcome[]): void => {
  for (const o of outcomes) {
    const what = o.op.op === "add" ? o.op.title : (o.title ?? ("id" in o.op ? o.op.id : ""));
    console.log(`  ${o.reason && !o.id ? "·" : o.op.op === "reinforce" ? "↑" : "+"} [${o.type ?? "?"}] ${what}${o.reason ? ` (${o.reason})` : ""}`);
  }
};

const printRender = (r: { written: string[]; removed: string[] }): void => {
  for (const w of r.written) console.log(`  wrote ${w}`);
  for (const w of r.removed) console.log(`  removed ${w}`);
};

const init = async (io: Io): Promise<void> =>
  withLock(io, async () => {
    if (!(await io.exists(PATHS.config))) await io.write(PATHS.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    if (!(await io.exists(PATHS.gitignore))) await io.write(PATHS.gitignore, ".local/\n");
    const config = await loadConfig(io);
    const state = await loadState(io);
    const v = await validateOps({ ops: await scanCommands(io, config.language), entries: state.entries, io, config, docs: await readDocs(io), now: now(), source: "init" });
    await appendLedger(io, v.records);
    console.log(`Archivist set up in ${io.root}`);
    printOutcomes([...v.applied, ...v.rejected]);
    if (!v.applied.length) console.log("  no new commands found to record");
    printRender(await renderAll(io, (await loadState(io)).entries, config));
    console.log("Commit .archivist/ and .claude/rules/archivist/ to share the knowledge with your team.");
  });

const status = async (io: Io): Promise<void> => {
  const state = await loadState(io);
  const active = activeEntries(state.entries);
  const by = (t: string) => active.filter((e) => e.type === t).length;
  const proposals = await listProposals(io);
  const reports = (await io.list(PATHS.reports)).sort();
  console.log(`${active.length} active entries: ${by("command")} commands, ${by("gotcha")} gotchas, ${by("decision")} decisions`);
  console.log(`${state.entries.size - active.length} deprecated`);
  console.log(`${proposals.length} proposals waiting for review (archivist review)`);
  console.log(reports.length ? `latest report: ${PATHS.reports}/${reports.at(-1)}` : "no reports yet");
};

const report = async (io: Io, which?: string): Promise<void> => {
  const reports = (await io.list(PATHS.reports)).sort();
  const file = which ?? (reports.length ? `${PATHS.reports}/${reports.at(-1)}` : undefined);
  const text = file ? await io.read(file) : undefined;
  console.log(text ?? "No report yet: Archivist writes one after a task that taught something.");
};

const options = (args: string[]): Record<string, string> => parseOptions(args).opts;

const add = async (io: Io, args: string[]): Promise<number> => {
  const o = options(args);
  const type = o.type as EntryType;
  if (!ENTRY_TYPES.includes(type) || !o.title || !o.content) {
    console.error("add needs --type command|gotcha|decision, --title and --content");
    return 2;
  }
  if (type === "decision" && !o.why) {
    console.error("a decision needs --why: the reason, and what was rejected");
    return 2;
  }
  const outcomes = await addEntry(
    io,
    await loadConfig(io),
    { type, title: o.title, content: o.content, ...(o.why ? { rationale: o.why } : {}), paths: commaList(o.paths), evidence: commaList(o.evidence) },
    now(),
  );
  printOutcomes(outcomes);
  return outcomes.some((x) => x.id) ? 0 : 1;
};

/** `edit` and `deprecate`: both fix what is already recorded. */
const change = async (io: Io, verb: "edit" | "deprecate", args: string[]): Promise<number> => {
  const { words, opts } = parseOptions(args);
  const id = words[0];
  if (!id) {
    console.error(`${verb} needs an entry id (see .archivist/INDEX.md or archivist recall)`);
    return 2;
  }
  const config = await loadConfig(io);
  const r =
    verb === "deprecate"
      ? await deprecateEntry(io, config, id, opts.reason ?? "", now())
      : await editEntry(io, config, id, editFromOptions(opts), now());
  if (!r.ok) {
    console.error(r.reason);
    return 1;
  }
  console.log(`${verb === "edit" ? "~" : "−"} [${r.entry.type}] ${r.entry.title} \`${r.entry.id}\``);
  printRender(r);
  return 0;
};

const review = async (io: Io, verb: "apply" | "skip", which: string | undefined): Promise<number> => {
  const proposals = await listProposals(io);
  const chosen = which ? pick(proposals, which) : [];
  if (!chosen.length) {
    console.error(`${verb} needs proposal numbers from \`archivist review\` (or all)`);
    return 2;
  }
  if (verb === "skip") console.log(`skipped ${await skipProposals(io, chosen, now())} proposal(s)`);
  else printOutcomes(await applyProposals(io, await loadConfig(io), chosen, now()));
  return 0;
};

const baseline = async (io: Io, args: string[]): Promise<void> => {
  const o = options(args);
  const created = [...(await loadState(io)).entries.values()].map((e) => e.created).sort()[0];
  // Before the first entry, sessions ran without Archivist's knowledge: that is the "before".
  const before = new Date(o.before ?? created ?? now());
  const { sessions, segments } = await readProjectSegments(io.root, before);
  const metrics = segments.map((s) => toMetrics(computeSignals(s), new Date(s.startedAt).toISOString(), "baseline"));
  const b: Baseline = { createdAt: now(), before: before.toISOString(), sessions, summary: summarize(metrics) };
  await io.write(BASELINE, JSON.stringify(b, null, 2) + "\n");
  console.log(`Baseline: ${b.summary.tasks} tasks from ${sessions} sessions before ${b.before.slice(0, 10)} (${transcriptDir(io.root)})`);
  console.log(compareText(undefined, b.summary).replace(/^No baseline yet.*\n\n/, "").replace("now (", "before ("));
};

const gc = async (io: Io, args: string[]): Promise<void> => {
  const o = options(args);
  const days = Number(o.days ?? 60);
  const state = await loadState(io);
  const quiet = await gcCandidates(io, state.entries, days, new Date());
  if (!(await loadConfig(io)).rules.files)
    console.log("Rule files are off, so no rule load counts as use: unused here means no recorded command was run and no task judged the entry.");
  if (!quiet.length) {
    console.log(`Every entry showed a sign of use in the last ${days} days.`);
    return;
  }
  for (const e of quiet) console.log(`  \`${e.id}\` [${e.type}] ${e.title}`);
  if (!args.includes("--apply")) {
    console.log(`${quiet.length} entries unused for ${days} days. Run with --apply to retire them (they stay in the ledger).`);
    return;
  }
  const retired = await withLock(io, async () => {
    const entries = (await loadState(io)).entries;
    const still = quiet.filter((e) => entries.get(e.id)?.status === "active");
    await appendLedger(io, gcRecords(still, days, now()));
    printRender(await renderAll(io, (await loadState(io)).entries, await loadConfig(io)));
    return still.length;
  });
  console.log(`retired ${retired} entries`);
};

const claudeVersion = (): number[] | undefined => {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  } catch {
    return undefined;
  }
};

const doctor = async (io: Io): Promise<boolean> => {
  let ok = true;
  const check = (pass: boolean, msg: string, hint?: string) => {
    console.log(`${pass ? "✔" : "✘"} ${msg}${!pass && hint ? `\n    ${hint}` : ""}`);
    ok &&= pass;
  };
  const node = Number(process.versions.node.split(".")[0]);
  check(node >= 20, `Node ${process.versions.node}`, "Archivist's CLI needs Node 20 or newer");
  const v = claudeVersion();
  if (v) {
    const recent = v[0]! > MIN_CLAUDE[0]! || (v[0] === MIN_CLAUDE[0] && (v[1]! > MIN_CLAUDE[1]! || (v[1] === MIN_CLAUDE[1] && v[2]! >= MIN_CLAUDE[2]!)));
    check(recent, `Claude Code ${v.join(".")}`, `the Archivist mod needs Claude Code ${MIN_CLAUDE.join(".")} or newer`);
  } else console.log("· claude not on PATH (fine inside the desktop app; the CLI checks are skipped)");
  check(await io.exists(PATHS.dir), `${PATHS.dir}/ exists`, "run `archivist init`");
  const configText = await io.read(PATHS.config);
  let configOk = true;
  if (configText) {
    try {
      JSON.parse(configText);
    } catch {
      configOk = false;
    }
  }
  check(configOk, `${PATHS.config} ${configText ? "parses" : "absent (defaults apply)"}`, "fix the JSON or delete the file");
  const state = await loadState(io);
  check(!state.badLines.length, `ledger: ${state.entries.size} entries`, `unreadable lines: ${state.badLines.join(", ")}`);
  const config = await loadConfig(io);
  for (const name of (await io.list(PATHS.rulesDir)).filter((n) => n.endsWith(".md"))) {
    const path = `${PATHS.rulesDir}/${name}`;
    const text = (await io.read(path)) ?? "";
    const lines = text.split("\n").length - 1;
    const core = path === PATHS.coreRule;
    // A path-scoped file carries its frontmatter on top of the budget.
    const budget = core ? config.budgets.coreLines : config.budgets.pathFileLines + 6;
    const chars = core ? config.budgets.coreChars : config.budgets.pathFileChars + 400;
    check(lines <= budget && text.length <= chars, `${path}: ${lines}/${budget} lines, ${text.length}/${chars} chars`, "run `archivist render`");
  }
  const stale = await findStale(io, state.entries);
  check(!stale.size, `${stale.size} stale entries (cited files are gone)`, `review them in ${PATHS.index}: update or deprecate`);
  return ok;
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const start = rootAt >= 0 ? args.splice(rootAt, 2)[1] : process.cwd();
  const [cmd, ...rest] = args;
  const io = nodeIo(findRoot(start ?? process.cwd()));
  switch (cmd) {
    case "init":
      await init(io);
      return 0;
    case "status":
      await status(io);
      return 0;
    case "report":
      await report(io, rest[0]);
      return 0;
    case "review":
      console.log(rest.includes("--json") ? reviewJson(await listProposals(io)) : reviewText(await listProposals(io)));
      return 0;
    case "apply":
    case "skip":
      return review(io, cmd, rest.join(","));
    case "add":
      return add(io, rest);
    case "edit":
    case "deprecate":
      return change(io, cmd, rest);
    case "render":
      printRender(await withLock(io, async () => renderAll(io, (await loadState(io)).entries, await loadConfig(io))));
      return 0;
    case "recall":
      console.log(recallText((await loadState(io)).entries, rest.join(" ")));
      return 0;
    case "baseline":
      await baseline(io, rest);
      return 0;
    case "stats":
      console.log(await statsText(io, (await loadState(io)).entries));
      return 0;
    case "health":
      console.log(await healthText(io, (await loadState(io)).entries, await loadConfig(io), new Date()));
      return 0;
    case "gc":
      await gc(io, rest);
      return 0;
    case "lint": {
      const findings = await lint(io, (await loadState(io)).entries, await loadConfig(io));
      for (const f of findings) console.log(`${f.level === "warn" ? "✘" : "·"} ${f.text}`);
      if (!findings.length) console.log("✔ nothing to report");
      return findings.some((f) => f.level === "warn") ? 1 : 0;
    }
    case "doctor":
      return (await doctor(io)) ? 0 : 1;
    case "uninstall": {
      const inMemory = (await loadMemoryCaches(io)).filter((m) => Object.keys(m.items).length);
      const removed = await uninstall(io.root, rest.includes("--purge"));
      for (const m of inMemory)
        console.log(`Entries also live in ${m.store} memory (project ${m.project}): run /archivist memory clear in a Claude Code session to remove them.`);
      for (const r of removed) console.log(`  removed ${r}`);
      if (!removed.length) console.log("Nothing generated by Archivist here.");
      if (!rest.includes("--purge")) console.log(`Kept ${PATHS.dir}/ (the ledger is the knowledge itself): add --purge to remove it too.`);
      console.log("To remove the plugin from Claude Code: /plugin uninstall archivist@archivist");
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
};

process.exitCode = await main();
