import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve("plugin-opencode");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const project = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.name !== "archivist-opencode" || manifest.version !== project.version || manifest.type !== "module") throw new Error("Invalid OpenCode package identity");
if (manifest.exports["."] !== "./index.js" || manifest.bin.archivist !== "./bin/archivist") throw new Error("Invalid OpenCode exports");
if (manifest.exports["./gui-experimental"] !== "./ui/gui-experimental.cjs") throw new Error("Missing OpenCode GUI export");
for (const name of ["index.js", "bin/archivist", "README.md"]) await access(resolve(root, name));
for (const name of ["recall", "remember", "decide", "triage"]) {
  const text = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  if (!text.startsWith(`---\nname: archivist-${name}\n`) || !text.includes("description:")) throw new Error(`Invalid OpenCode skill: ${name}`);
}
await access(resolve(root, "bin/archivist"), constants.X_OK);
const plugin = (await import(pathToFileURL(resolve(root, "index.js")).href)).default;
if (plugin.id !== "archivist" || typeof plugin.setup !== "function") throw new Error("Invalid OpenCode V2 plugin definition");
if (project.devDependencies["@opencode/plugin"] !== "2.2.5") throw new Error("OpenCode SDK must match the tested release");
const guiManifest = JSON.parse(await readFile(resolve(root, "ui/package.json"), "utf8"));
if (guiManifest.name !== "archivist-ui" || guiManifest.version !== project.version || guiManifest.exports["./gui-experimental"] !== "./gui-experimental.cjs") throw new Error("Invalid GUI companion package");
const gui = await readFile(resolve(root, "ui/gui-experimental.cjs"), "utf8");
const exports = {};
runInNewContext(gui, { exports, require: (name) => {
  if (name === "@opencode/plugin/gui") return { Plugin: { define: (value) => value } };
  if (name === "@opencode/plugin/rpc") return { Rpc: { define: (value) => value } };
  if (name === "solid-js/web") return { template: () => () => {}, delegateEvents: () => {} };
  if (name === "solid-js") return {};
  throw new Error(`Unexpected GUI dependency: ${name}`);
} });
if (typeof exports.default?.setup !== "function") throw new Error("Invalid OpenCode GUI definition");
console.log("OpenCode 2.2.5 package: server, GUI, companion, CLI and skills verified");
