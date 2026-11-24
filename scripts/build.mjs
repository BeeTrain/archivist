// Builds the two runtime artifacts of the plugin:
//   plugin/hooks/register.js — the Claude Code mod (no Node APIs; all I/O goes through `$`)
//   plugin/bin/archivist     — the Node CLI (on the Bash tool's PATH while the plugin is enabled)
import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build as buildGui } from "vite";

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

await build({
  entryPoints: ["src/adapters/codex/entry.ts"],
  outfile: "plugin-codex/bin/archivist",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("plugin-codex/bin/archivist", 0o755);

await build({
  entryPoints: ["src/adapters/opencode/index.ts"],
  outfile: "plugin-opencode/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  external: ["effect", "effect/*"],
  legalComments: "none",
});

await build({
  entryPoints: ["src/adapters/opencode/cli.ts"],
  outfile: "plugin-opencode/bin/archivist",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("plugin-opencode/bin/archivist", 0o755);

await build({
  entryPoints: ["src/adapters/antigravity/entry.ts"],
  outfile: "plugin-antigravity/bin/archivist",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("plugin-antigravity/bin/archivist", 0o755);
chmodSync("plugin-antigravity/bin/run-hook.sh", 0o755);

await build({
  entryPoints: ["src/adapters/antigravity/mcp-entry.ts"],
  outfile: "plugin-antigravity/bin/archivist-mcp",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("plugin-antigravity/bin/archivist-mcp", 0o755);
chmodSync("plugin-antigravity/bin/run-mcp.sh", 0o755);

const panelBundle = await build({
  entryPoints: ["src/adapters/antigravity/panel-ui/panel.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
});
const panelJs = panelBundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const panelCss = readFileSync("src/adapters/antigravity/panel-ui/panel.css", "utf8");
const panelTemplate = readFileSync("src/adapters/antigravity/panel-ui/panel.html", "utf8");
const panelHtml = panelTemplate
  .replace("/*__ARCHIVIST_CSS__*/", () => panelCss)
  .replace("/*__ARCHIVIST_JS__*/", () => panelJs);
mkdirSync("plugin-antigravity/ui", { recursive: true });
writeFileSync("plugin-antigravity/ui/panel.html", panelHtml, "utf8");

console.log(
  "built plugin-codex/bin/archivist, plugin-opencode/index.js, plugin-opencode/bin/archivist, plugin-antigravity/bin/archivist, plugin-antigravity/bin/archivist-mcp, plugin-antigravity/ui/panel.html",
);
await buildGui();
