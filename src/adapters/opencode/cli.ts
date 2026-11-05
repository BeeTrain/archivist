import { findRoot, nodeIo } from "../../cli/node-io.js";
import { analysisCommand } from "./commands.js";

process.env.ARCHIVIST_TARGET = "opencode";
if (process.argv[2] === "analysis" || process.argv[2] === "collection") {
  console.log(await analysisCommand(nodeIo(findRoot(process.cwd()), "opencode"), process.argv[3]));
} else {
  await import("../../cli/main.js");
}
