// archivist CLI: the terminal side of the plugin. The Claude Code mod does the per-task work; this sets a
// project up, records and reviews knowledge by hand, and checks the setup.
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, loadConfig } from "../core/config.js";
import { PATHS, type Io } from "../core/io.js";
import { activeEntries, appendLedger, loadState } from "../core/ledger.js";
import { findStale, renderAll } from "../core/render.js";
import { addEntry, applyProposals, listProposals, pick, reviewText, skipProposals } from "../core/review.js";
import { ENTRY_TYPES, type EntryType } from "../core/types.js";
import { validateOps, type Outcome } from "../core/validate.js";
import { findRoot, nodeIo } from "./node-io.js";
import { scanCommands } from "./scan.js";

const HELP = `archivist — project knowledge from coding-agent sessions

Usage: archivist <command> [--root <dir>]

  init                  set up .archivist/ and seed exact build/test/lint commands from the project's manifests
  status                what is recorded: entries by type, proposals waiting for review
  report [file]         print the latest task report, or the given one
  review                list the proposals waiting for review
  apply <n|1,3|all>     record proposals as they are
  skip <n|1,3|all>      drop proposals; the same idea is not proposed again
  add --type <command|gotcha|decision> --title <t> --content <c> [--why <reason>] [--paths <glob,glob>] [--evidence <file,file>]
                        record a fact by hand (decisions need --why)
  render                regenerate the rule files, index and ADRs from the ledger
  doctor                check the setup
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

const init = async (io: Io): Promise<void> => {
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
};

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

/** `--name value` options; repeated names keep the last value. */
const options = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--") && i + 1 < args.length) out[a.slice(2)] = args[++i]!;
  }
  return out;
};

const list = (s: string | undefined): string[] => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

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
    { type, title: o.title, content: o.content, ...(o.why ? { rationale: o.why } : {}), paths: list(o.paths), evidence: list(o.evidence) },
    now(),
  );
  printOutcomes(outcomes);
  return outcomes.some((x) => x.id) ? 0 : 1;
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
    const lines = ((await io.read(path)) ?? "").split("\n").length - 1;
    const budget = path === PATHS.coreRule ? config.budgets.coreLines : config.budgets.pathFileLines + 6;
    check(lines <= budget, `${path}: ${lines}/${budget} lines`, "run `archivist render`");
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
      console.log(reviewText(await listProposals(io)));
      return 0;
    case "apply":
    case "skip":
      return review(io, cmd, rest.join(","));
    case "add":
      return add(io, rest);
    case "render":
      printRender(await renderAll(io, (await loadState(io)).entries, await loadConfig(io)));
      return 0;
    case "doctor":
      return (await doctor(io)) ? 0 : 1;
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
