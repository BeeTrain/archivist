import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({ plugins: [gui({ entry: "src/adapters/opencode/gui.tsx", outFile: "plugin-opencode/ui/gui-experimental.cjs" })] });
