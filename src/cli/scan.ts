// Cold start: exact commands found in the project's own manifests. No overview, no structure: only commands.
import type { Io } from "../core/io.js";
import type { ProposedOp } from "../core/types.js";

const USEFUL = /^(test|tests|build|lint|typecheck|type-check|check|dev|start|format|fmt|e2e|ci|verify)([:-].+)?$/;

const titles: Record<string, string> = {
  test: "Run tests",
  tests: "Run tests",
  build: "Build",
  lint: "Lint",
  typecheck: "Typecheck",
  "type-check": "Typecheck",
  check: "Run all checks",
  dev: "Start dev server",
  start: "Start",
  format: "Format code",
  fmt: "Format code",
  e2e: "Run e2e tests",
  ci: "Run the CI pipeline locally",
  verify: "Verify",
};

const title = (name: string): string => {
  const [base, rest] = name.split(/[:-](.+)/);
  const t = titles[base ?? name] ?? name;
  return rest ? `${t} (${rest})` : t;
};

const packageManager = async (io: Io): Promise<string> => {
  if (await io.exists("pnpm-lock.yaml")) return "pnpm";
  if (await io.exists("yarn.lock")) return "yarn";
  if ((await io.exists("bun.lockb")) || (await io.exists("bun.lock"))) return "bun";
  return "npm";
};

export const scriptCommand = (pm: string, name: string): string => {
  if (pm === "npm") return name === "test" || name === "start" ? `npm ${name}` : `npm run ${name}`;
  if (pm === "bun") return `bun run ${name}`;
  return `${pm} ${name}`;
};

export const scanCommands = async (io: Io): Promise<ProposedOp[]> => {
  const ops: ProposedOp[] = [];
  const add = (name: string, cmd: string, detail: string, file: string, anchor: string) =>
    ops.push({
      op: "add",
      type: "command",
      title: title(name),
      content: `\`${cmd}\`${detail ? ` — ${detail}` : ""}`,
      evidence: [{ file, anchor }],
      confidence: 0.85,
    });

  const pkg = await io.read("package.json");
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      const pm = await packageManager(io);
      for (const [name, body] of Object.entries(scripts)) {
        if (!USEFUL.test(name)) continue;
        add(name, scriptCommand(pm, name), `runs \`${body}\``, "package.json", `scripts.${name}`);
      }
    } catch {
      /* unreadable package.json: nothing to seed */
    }
  }

  for (const [file, runner] of [
    ["Makefile", "make"],
    ["justfile", "just"],
  ] as const) {
    const text = await io.read(file);
    if (!text) continue;
    for (const m of text.matchAll(/^([A-Za-z0-9_-]+):(?!=)/gm)) {
      const name = m[1]!;
      if (USEFUL.test(name)) add(name, `${runner} ${name}`, "", file, name);
    }
  }

  if (await io.exists("Cargo.toml")) {
    add("build", "cargo build", "", "Cargo.toml", "package");
    add("test", "cargo test", "", "Cargo.toml", "package");
  }
  if (await io.exists("go.mod")) add("test", "go test ./...", "", "go.mod", "module");
  return ops;
};
