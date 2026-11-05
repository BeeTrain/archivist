import { loadConfig } from "../../core/config.js";
import type { Io } from "../../core/io.js";
import { loadState } from "../../core/ledger.js";
import { findStale, groupAreas, renderAreas, renderCore } from "../../core/render.js";
import { globToRegExp } from "../../core/text.js";

export const knowledge = async (io: Io, touched: string[] = []): Promise<string> => {
  const config = await loadConfig(io);
  if (!config.enabled) return "";
  const entries = (await loadState(io)).entries;
  const stale = await findStale(io, entries);
  const all = [...entries.values()];
  const core = renderCore(all, config, stale).replace("Before exploring, try `archivist recall <words>`.", "Before exploring, use the archivist tool with command `recall <words>`.");
  const areas = renderAreas(all, config, stale);
  const scoped = [...groupAreas(all, stale)].filter(([, area]) => area.paths.some((glob) => touched.some((path) => globToRegExp(glob).test(path))))
    .map(([path]) => areas.get(path) ?? "").join("\n").slice(0, config.budgets.pathFileChars);
  return `${core}\n${scoped}\nUse the archivist tool to search or manage knowledge. Save decisions only when the user has settled on an approach; background proposals require review.`;
};
