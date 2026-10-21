// archivist CLI: the terminal side of the plugin. The Claude Code mod does the per-task work; this sets a
// project up, shows what is recorded and checks the setup.
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, loadConfig } from "../core/config.js";
import { PATHS, type Io } from "../core/io.js";
import { activeEntries, appendLedger, loadState } from "../core/ledger.js";
import { renderViews, writeViews } from "../core/render.js";
import { validateOps } from "../core/validate.js";
import { findRoot, nodeIo } from "./node-io.js";
import { scanCommands } from "./scan.js";

const HELP = `archivist — project knowledge from coding-agent sessions

Usage: archivist <command> [--root <dir>]

  init      set up .archivist/ and seed exact build/test/lint commands from the project's manifests
  status    what is recorded: entries by type, proposals waiting for review
  report    print the latest task report (or: report <file>)
  render    regenerate .claude/rules/archivist/ and .archivist/ views from the ledger
  doctor    check the setup
`;

const MIN_CLAUDE = [2, 1, 290];

const readDocs = async (io: Io): Promise<string[]> => {
  const out: string[] = [];
  for (const p of ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "README.md"]) {
    const t = await io.read(p);
    if (t) out.push(t);
  }
  return out;
};

const init = async (io: Io): Promise<void> => {
  if (!(await io.exists(PATHS.config))) await io.write(PATHS.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  if (!(await io.exists(PATHS.gitignore))) await io.write(PATHS.gitignore, ".local/\n");
  const config = await loadConfig(io);
  const state = await loadState(io);
  const v = await validateOps({
    ops: await scanCommands(io),
    entries: state.entries,
    io,
    config,
    docs: await readDocs(io),
    now: new Date().toISOString(),
    source: "init",
  });
  await appendLedger(io, v.records);
  const after = await loadState(io);
  const written = await writeViews(io, renderViews(after.entries, config));
  console.log(`Archivist set up in ${io.root}`);
  for (const o of v.applied) console.log(`  + [${o.type}] ${o.title}${o.reason ? ` (${o.reason})` : ""}`);
  for (const o of v.rejected) console.log(`  · skipped ${o.op.op === "add" ? o.op.title : ""}: ${o.reason}`);
  if (!v.applied.length) console.log("  no new commands found to record");
  for (const w of written) console.log(`  wrote ${w}`);
  console.log("Commit .archivist/ and .claude/rules/archivist/ to share the knowledge with your team.");
};

const status = async (io: Io): Promise<void> => {
  const state = await loadState(io);
  const active = activeEntries(state.entries);
  const by = (t: string) => active.filter((e) => e.type === t).length;
  const proposals = await io.list(PATHS.proposals);
  const reports = (await io.list(PATHS.reports)).sort();
  console.log(`${active.length} active entries: ${by("command")} commands, ${by("gotcha")} gotchas, ${by("decision")} decisions`);
  console.log(`${state.entries.size - active.length} deprecated`);
  console.log(`${proposals.length} proposals waiting for review in ${PATHS.proposals}/`);
  console.log(reports.length ? `latest report: ${PATHS.reports}/${reports.at(-1)}` : "no reports yet");
};

const report = async (io: Io, which?: string): Promise<void> => {
  const reports = (await io.list(PATHS.reports)).sort();
  const file = which ?? (reports.length ? `${PATHS.reports}/${reports.at(-1)}` : undefined);
  const text = file ? await io.read(file) : undefined;
  if (!text) {
    console.log("No report yet: Archivist writes one after a task that taught something.");
    return;
  }
  console.log(text);
};

const render = async (io: Io): Promise<void> => {
  const config = await loadConfig(io);
  const state = await loadState(io);
  const written = await writeViews(io, renderViews(state.entries, config));
  console.log(written.length ? written.map((w) => `wrote ${w}`).join("\n") : "views are up to date");
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
  const core = (await io.read(PATHS.coreRule)) ?? "";
  const lines = core ? core.split("\n").length - 1 : 0;
  check(lines <= config.budgets.coreLines, `${PATHS.coreRule}: ${lines}/${config.budgets.coreLines} lines`, "run `archivist render`");
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
    case "render":
      await render(io);
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
