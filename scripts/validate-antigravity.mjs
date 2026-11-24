import { access, constants, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("plugin-antigravity");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));

if (manifest.name !== "archivist" || manifest.version !== pkg.version) {
  throw new Error("Invalid Antigravity plugin.json name or version");
}

for (const rel of [
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "rules/AGENTS.md",
  "assets/logo.svg",
  "bin/archivist",
  "bin/archivist-mcp",
  "bin/run-hook.sh",
  "bin/run-mcp.sh",
  "ui/panel.html",
]) {
  await access(resolve(root, rel));
}

await access(resolve(root, "bin/archivist"), constants.X_OK);
await access(resolve(root, "bin/archivist-mcp"), constants.X_OK);
await access(resolve(root, "bin/run-hook.sh"), constants.X_OK);
await access(resolve(root, "bin/run-mcp.sh"), constants.X_OK);

const mcp = JSON.parse(await readFile(resolve(root, "mcp_config.json"), "utf8"));
if (!mcp.mcpServers?.panel?.command || !Array.isArray(mcp.mcpServers.panel.args)) {
  throw new Error("Invalid Antigravity mcp_config.json");
}

const htmlPath = resolve(root, "ui/panel.html");
const htmlStat = await stat(htmlPath);
if (htmlStat.size === 0 || htmlStat.size > 10 * 1024 * 1024) {
  throw new Error("Invalid ui/panel.html size");
}
const html = await readFile(htmlPath, "utf8");
if (html.includes("/*__ARCHIVIST_CSS__*/") || html.includes("/*__ARCHIVIST_JS__*/")) {
  throw new Error("Unreplaced template placeholder in ui/panel.html");
}
if (/<script[^>]+src=|<link[^>]+rel=["']stylesheet/i.test(html)) {
  throw new Error("ui/panel.html must be self-contained without external script/stylesheet links");
}

const hooks = JSON.parse(await readFile(resolve(root, "hooks.json"), "utf8"));
for (const event of ["SessionStart", "PreInvocation", "PostToolUse", "Stop"]) {
  if (!hooks.archivist?.[event]?.length) throw new Error(`Missing hook event: ${event}`);
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

console.log("Antigravity package: manifest, MCP App, hooks, CLI and skills verified");
