import { readFile, access } from "node:fs/promises";
import { resolve, relative } from "node:path";

const root = resolve("plugin-codex");
const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
if (manifest.name !== "archivist-codex" || !manifest.version) throw new Error("Invalid Codex identity");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== pkg.version) throw new Error("Codex version differs from package.json");
const marketplace = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"));
const source = marketplace.plugins.find((p) => p.name === manifest.name)?.source;
if (marketplace.name !== "archivist" || source?.source !== "git-subdir" || source.path !== "./plugin-codex" || source.url !== "https://github.com/BeeTrain/archivist.git" || source.ref !== `v${pkg.version}`) throw new Error("Codex marketplace must reference the published version");
for (const path of [manifest.skills, manifest.hooks, "./bin/archivist"]) {
  if (typeof path !== "string" || !path.startsWith("./") || relative(root, resolve(root, path)).startsWith("..")) throw new Error("Invalid package path");
  await access(resolve(root, path));
}
const hooks = JSON.parse(await readFile(resolve(root, manifest.hooks), "utf8"));
for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt", "SessionEnd"]) {
  if (!hooks.hooks[event]?.length) throw new Error(`Missing ${event}`);
}
for (const name of ["setup", "remember", "decide", "triage", "recall", "collection", "panel"]) {
  const skill = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  if (!skill.startsWith(`---\nname: ${name}\n`) || !skill.includes("description:")) throw new Error(`Invalid skill ${name}`);
  if (skill.includes("CLAUDE_PLUGIN_ROOT")) throw new Error(`Claude path in ${name}`);
}
console.log("Codex package: manifest, paths, hooks and skills verified");
