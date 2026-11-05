import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "../../core/config.js";
import { safeText } from "../../core/capture.js";
import { isExcluded } from "../../core/privacy.js";
import type { ToolEvent } from "../../core/types.js";

export const projectPath = (value: unknown, root: string, config: Config): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return;
  const path = relative(root, resolve(root, value)).replaceAll("\\", "/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) || isExcluded(path, config.privacy.excludePaths)) return;
  return path;
};

export interface ToolInput {
  tool: string;
  input: unknown;
  status: "completed" | "error";
  result?: { metadata?: Record<string, unknown> };
  error?: { message: string };
}

export const captureTool = (event: ToolInput, root: string, config: Config): ToolEvent[] => {
  if (event.tool === "archivist") return [];
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
  const clean = (value: unknown, max = 400) => safeText(value, config.privacy.excludePaths, root, max);
  const exit = event.result?.metadata?.exit ?? event.result?.metadata?.exitCode ?? event.result?.metadata?.exit_code;
  const ok = event.status === "completed" && !(typeof exit === "number" && exit !== 0);
  const error = event.status === "error" ? clean(event.error?.message) : !ok ? `Exit code: ${exit}` : undefined;
  const make = (tool: string, target?: string): ToolEvent => ({ tool, ...(target ? { target } : {}), ok, ...(error ? { error } : {}) });
  if (/^(?:apply_patch|patch)$/.test(event.tool)) {
    const patch = String(input.patchText ?? input.patch ?? input.command ?? "");
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].flatMap((m) => {
      const path = projectPath(m[1], root, config);
      return path ? [make("Edit", path)] : [];
    });
  }
  if (/^(?:read|edit|write|multiedit)$/.test(event.tool)) {
    const path = projectPath(input.filePath ?? input.path ?? input.file_path, root, config);
    return path ? [make(event.tool === "read" ? "Read" : "Edit", path)] : [];
  }
  const target = clean(input.command ?? input.cmd ?? input.pattern ?? input.query);
  const names: Record<string, string> = { bash: "Bash", shell: "Bash", grep: "Grep", glob: "Glob", list: "LS" };
  return [make(names[event.tool] ?? event.tool.slice(0, 100), target || undefined)];
};
