import { spawn } from "node:child_process";
import { findRoot, nodeIo } from "../../cli/node-io.js";
import { loadConfig } from "../../core/config.js";
import { PATHS } from "../../core/io.js";
import { withLock } from "../../core/lock.js";
import { collectionSummary, handleHook, resolveHookRoot } from "./hooks.js";
import { analysisStatus, runWorker } from "./queue.js";
import { registerWorkspace } from "./registry.js";

process.env.ARCHIVIST_TARGET = "antigravity";

const extractRootArg = (args: string[]): { root: string; rest: string[] } => {
  const copy = [...args];
  const idx = copy.indexOf("--root");
  const start = idx >= 0 ? copy.splice(idx, 2)[1] : process.cwd();
  return { root: findRoot(start ?? process.cwd()), rest: copy };
};

const cmd = process.argv[2];

if (cmd === "hook") {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4_000_000) throw new Error("Hook payload exceeds 4 MB");
    }
    const input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const response = await handleHook(input);
    console.log(JSON.stringify(response));
    if (
      !process.env.ARCHIVIST_CHILD &&
      (input.hookEventName === "Stop" || input.hookEventName === "SessionStart")
    ) {
      const root = resolveHookRoot(input);
      if (root) {
        const config = await loadConfig(nodeIo(root, "antigravity"));
        if (config.enabled && config.antigravity.enabled) {
          const worker = spawn(process.execPath, [process.argv[1]!, "worker", root], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, ARCHIVIST_CHILD: "1" },
          });
          worker.on("error", () => {});
          worker.unref();
        }
      }
    }
  } catch {
    console.error("Archivist hook failed; collection skipped for this event.");
    console.log("{}");
  }
} else if (cmd === "worker") {
  await runWorker(findRoot(process.argv[3] ?? process.cwd()));
} else if (cmd === "analysis") {
  const { root, rest } = extractRootArg(process.argv.slice(3));
  const io = nodeIo(root, "antigravity");
  const action = rest[0] ?? "status";
  if (action === "enable" || action === "disable") {
    await withLock(io, async () => {
      const raw = JSON.parse((await io.read(PATHS.config)) ?? "{}") as Record<string, unknown>;
      const prev = raw.antigravity && typeof raw.antigravity === "object" ? (raw.antigravity as Record<string, unknown>) : {};
      await io.write(
        PATHS.config,
        JSON.stringify({ ...raw, antigravity: { ...prev, enabled: action === "enable" } }, null, 2) + "\n",
      );
    });
  } else if (action === "run") {
    await runWorker(io.root, undefined, { once: true });
  } else if (action !== "status") {
    throw new Error("Usage: archivist analysis [status|enable|disable|run] [--root <dir>]");
  }
  console.log(JSON.stringify(await analysisStatus(io), null, 2));
} else if (cmd === "collection") {
  const { root } = extractRootArg(process.argv.slice(3));
  console.log(await collectionSummary(root));
} else if (cmd === "register") {
  const { root } = extractRootArg(process.argv.slice(3));
  await registerWorkspace(root);
  console.log(`Registered project in Archivist UI: ${root}`);
} else {
  if (cmd === "init" || cmd === "add" || cmd === "status" || cmd === "panel") {
    const { root } = extractRootArg(process.argv.slice(3));
    await registerWorkspace(root).catch(() => {});
  }
  await import("../../cli/main.js");
}
