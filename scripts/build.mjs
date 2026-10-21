// Builds the two runtime artifacts of the plugin:
//   plugin/hooks/register.js — the Claude Code mod (no Node APIs; all I/O goes through `$`)
//   plugin/bin/archivist     — the Node CLI (on the Bash tool's PATH while the plugin is enabled)
import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/adapters/claude/mod/register.ts"],
  outfile: "plugin/hooks/register.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["claude-code"],
  // The mods validator reads this file statically: keep names and literals intact.
  minify: false,
  legalComments: "none",
});

await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "plugin/bin/archivist",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("plugin/bin/archivist", 0o755);

console.log("built plugin/hooks/register.js, plugin/bin/archivist");
