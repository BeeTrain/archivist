import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, handleHook, collectionSummary } from "../src/adapters/codex/hooks.js";
import { renderAll } from "../src/core/render.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { entry, memoryIo } from "./helpers.js";

describe("Codex adapter", () => {
  it("records metadata without prompt, result, command or excluded patch paths", () => {
    const e = capture({ session_id: "private-session", turn_id: "turn", hook_event_name: "PostToolUse", tool_name: "apply_patch", prompt: "secret", tool_response: "private", tool_input: { command: "*** Update File: src/a.ts\n+password=hidden\n*** Add File: .env\n*** Delete File: ../outside" } }, [".env"]);
    expect(e?.files).toEqual(["src/a.ts"]);
    expect(JSON.stringify(e)).not.toMatch(/private-session|password|hidden|outside/);
    expect(capture({ session_id: "s", hook_event_name: "Unknown" }, [])).toBeUndefined();
  });

  it("renders and prunes only Codex views while preserving Claude views", async () => {
    const io = memoryIo({ ".claude/rules/archivist/core.md": "Claude" });
    io.target = "codex";
    const entries = new Map([["e", entry({ id: "e", type: "gotcha", title: "Build", content: "Use build" })]]);
    await renderAll(io, entries, DEFAULT_CONFIG);
    expect(io.files.get(".claude/rules/archivist/core.md")).toBe("Claude");
    expect(io.files.get(".archivist/codex/rules/core.md")).toContain("Use build");
    expect(io.files.has(".claude/skills")).toBe(false);
  });

  it("deduplicates delivered tools, ignores local data in git and returns bounded context", async () => {
    const root = await mkdtemp(join(tmpdir(), "archivist-codex-"));
    try {
      const input = { cwd: root, session_id: "session", turn_id: "turn", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call", tool_input: { command: "echo secret" } };
      await Promise.all([handleHook(input), handleHook(input)]);
      const summary = JSON.parse(await collectionSummary(root));
      expect(summary.events).toBe(1);
      expect(await readFile(join(root, ".archivist/.gitignore"), "utf8")).toContain(".local/");
      const result = await handleHook({ ...input, hook_event_name: "SessionStart" });
      expect(JSON.stringify(result)).toContain("additionalContext");
      expect(JSON.stringify(result).length).toBeLessThan(8000);
      expect(await readdir(root)).not.toContain(".claude");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
