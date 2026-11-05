import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { splitArgs } from "../../core/args.js";
import type { Io } from "../../core/io.js";
import { PATHS } from "../../core/io.js";
import { withLock } from "../../core/lock.js";
import { analysisStatus } from "./queue.js";

const exec = promisify(execFile);
const ALLOWED = new Set(["init", "status", "report", "review", "apply", "skip", "add", "edit", "deprecate", "recall", "stats", "health", "gc", "lint", "render", "doctor", "help"]);

export const analysisCommand = async (io: Io, action = "status"): Promise<string> => {
  if (action === "enable" || action === "disable") {
    await withLock(io, async () => {
      const raw = JSON.parse((await io.read(PATHS.config)) ?? "{}");
      await io.write(PATHS.config, JSON.stringify({ ...raw, opencode: { ...raw.opencode, enabled: action === "enable" } }, null, 2) + "\n");
    });
  } else if (action !== "status") throw new Error("Usage: archivist analysis [status|enable|disable]");
  return analysisStatus(io);
};

export const runCommand = async (io: Io, raw: string, cli: string): Promise<string> => {
  const args = splitArgs(raw);
  const verb = args[0] ?? "status";
  if (verb === "analysis" || verb === "collection") return analysisCommand(io, args[1]);
  if (!ALLOWED.has(verb) || args.some((arg) => arg === "--root" || arg === "--target" || arg.startsWith("--root=") || arg.startsWith("--target=")))
    throw new Error("Use Archivist commands in the current project; panel, baseline and uninstall are CLI-only.");
  try {
    const result = await exec("node", [cli, "--root", io.root, "--target", "opencode", ...(args.length ? args : [verb])], { cwd: io.root, timeout: 30000, maxBuffer: 1000000 });
    return result.stdout.trim() || result.stderr.trim() || "Done";
  } catch (err) {
    const result = err as { stdout?: string; stderr?: string };
    return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "Archivist command failed; Node.js 20 or newer must be available.";
  }
};
