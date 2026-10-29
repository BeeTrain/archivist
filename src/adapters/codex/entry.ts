import { handleHook, collectionSummary } from "./hooks.js";
import { findRoot } from "../../cli/node-io.js";

process.env.ARCHIVIST_TARGET = "codex";
if (process.argv[2] === "hook") {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4_000_000) throw new Error("Hook payload exceeds 4 MB");
    }
    console.log(JSON.stringify(await handleHook(JSON.parse(raw))));
  } catch {
    console.error("Archivist hook failed; collection skipped for this event.");
    console.log("{}");
  }
} else if (process.argv[2] === "collection") {
  console.log(await collectionSummary(findRoot(process.cwd())));
} else {
  await import("../../cli/main.js");
}
