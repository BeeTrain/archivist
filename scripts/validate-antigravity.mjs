import { access, constants, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("plugin-antigravity");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
const sidecarPkg = JSON.parse(await readFile(resolve(root, "sidecars/archivist_panel/package.json"), "utf8"));

if (manifest.name !== "archivist" || manifest.version !== pkg.version) {
  throw new Error("Invalid Antigravity plugin.json name or version");
}
if (sidecarPkg.version !== pkg.version) {
  throw new Error("Invalid Antigravity sidecar package.json version");
}

for (const rel of [
  "plugin.json",
  "hooks.json",
  "rules/AGENTS.md",
  "assets/logo.svg",
  "bin/archivist",
  "bin/run-hook.sh",
  "sidecars/archivist_panel/sidecar.json",
  "sidecars/archivist_panel/package.json",
  "sidecars/archivist_panel/main.mjs",
  "sidecars/archivist_panel/index.html",
  "sidecars/archivist_panel/styles.css",
  "sidecars/archivist_panel/app.js",
]) {
  await access(resolve(root, rel));
}

await access(resolve(root, "bin/archivist"), constants.X_OK);
await access(resolve(root, "bin/run-hook.sh"), constants.X_OK);

const hooks = JSON.parse(await readFile(resolve(root, "hooks.json"), "utf8"));
for (const event of ["SessionStart", "PreInvocation", "PostToolUse", "Stop"]) {
  if (!hooks.archivist?.[event]?.length) throw new Error(`Missing hook event: ${event}`);
}

const sidecar = JSON.parse(await readFile(resolve(root, "sidecars/archivist_panel/sidecar.json"), "utf8"));
if (!sidecar.has_web_ui || sidecar.ui_config?.views?.[0]?.entrypoint !== "SIDECAR_UI_ENTRYPOINT_AUX_PANE") {
  throw new Error("Invalid sidecar.json UI config");
}

for (const name of [
  "archivist-setup",
  "archivist-panel",
  "archivist-recall",
  "archivist-remember",
  "archivist-decide",
  "archivist-triage",
  "archivist-collection",
]) {
  const skill = await readFile(resolve(root, "skills", name, "SKILL.md"), "utf8");
  if (!skill.startsWith(`---\nname: ${name}\n`) || !skill.includes("description:")) {
    throw new Error(`Invalid skill frontmatter: ${name}`);
  }
}

console.log("Antigravity package: manifest, hooks, CLI, UI sidecar and skills verified");
