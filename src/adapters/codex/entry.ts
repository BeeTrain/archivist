import { handleHook, collectionSummary } from "./hooks.js";
import { findRoot } from "../../cli/node-io.js";
import { spawn } from "node:child_process";
import { loadConfig } from "../../core/config.js";
import { nodeIo } from "../../cli/node-io.js";
import { runWorker, analysisStatus } from "./queue.js";
import { withLock } from "../../core/lock.js";
import { PATHS } from "../../core/io.js";

process.env.ARCHIVIST_TARGET = "codex";
if (process.argv[2] === "hook") {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4_000_000) throw new Error("Hook payload exceeds 4 MB");
    }
    const input = JSON.parse(raw);
    console.log(JSON.stringify(await handleHook(input)));
    if (!process.env.ARCHIVIST_CHILD && typeof input.cwd === "string" && ["SessionStart", "Stop", "Interrupt", "SessionEnd"].includes(input.hook_event_name)) {
      const root = findRoot(input.cwd);
      const config = await loadConfig(nodeIo(root, "codex"));
      if (config.enabled && config.codex.enabled) {
        const worker = spawn(process.execPath, [process.argv[1]!, "worker", root], { detached: true, stdio: "ignore", env: { ...process.env, ARCHIVIST_CHILD: "1" } });
        worker.on("error", () => {});
        worker.unref();
      }
    }
  } catch {
    console.error("Archivist hook failed; collection skipped for this event.");
    console.log("{}");
  }
} else if (process.argv[2] === "worker") {
  await runWorker(findRoot(process.argv[3] ?? process.cwd()));
} else if (process.argv[2] === "analysis") {
  const io = nodeIo(findRoot(process.cwd()), "codex");
  const action = process.argv[3] ?? "status";
  if (action === "enable" || action === "disable") {
    await withLock(io, async () => {
      const raw = JSON.parse((await io.read(PATHS.config)) ?? "{}");
      await io.write(PATHS.config, JSON.stringify({ ...raw, codex: { ...raw.codex, enabled: action === "enable" } }, null, 2) + "\n");
    });
  } else if (action === "run") {
    await runWorker(io.root);
  } else if (action !== "status") {
    throw new Error("Usage: archivist analysis [status|enable|disable|run]");
  }
  console.log(JSON.stringify(await analysisStatus(io), null, 2));
} else if (process.argv[2] === "collection") {
  console.log(await collectionSummary(findRoot(process.cwd())));
} else {
  await import("../../cli/main.js");
}
