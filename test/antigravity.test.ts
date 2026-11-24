import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { capture, collectionSummary, handleHook } from "../src/adapters/antigravity/hooks.js";
import { parseAgyReply } from "../src/adapters/antigravity/llm.js";
import { analysisStatus, captureTask, processTask } from "../src/adapters/antigravity/queue.js";
import {
  uiAdd,
  uiAnalysis,
  uiDeprecate,
  uiInit,
  uiMaintenance,
  uiRegisterProject,
  uiReport,
  uiSettle,
  uiSnapshot,
} from "../src/adapters/antigravity/sidecar-api.js";
import { nodeIo } from "../src/cli/node-io.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { PATHS } from "../src/core/io.js";
import { renderAll } from "../src/core/render.js";
import { entry, memoryIo } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("Antigravity adapter", () => {
  let stateDir: string;
  let prevStateEnv: string | undefined;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "archivist-agy-state-"));
    prevStateEnv = process.env.ARCHIVIST_ANTIGRAVITY_STATE;
    process.env.ARCHIVIST_ANTIGRAVITY_STATE = join(stateDir, "state.json");
  });

  afterEach(async () => {
    if (prevStateEnv === undefined) delete process.env.ARCHIVIST_ANTIGRAVITY_STATE;
    else process.env.ARCHIVIST_ANTIGRAVITY_STATE = prevStateEnv;
    await rm(stateDir, { recursive: true, force: true });
  });

  it("captures metadata safely without secrets or excluded files", () => {
    const e = capture(
      {
        conversationId: "conv-secret-123",
        hookEventName: "PostToolUse",
        stepIdx: 4,
        toolCall: { id: "call-1", name: "edit_file", args: { Path: "/repo/src/app.ts", TargetFile: "/repo/.env" } },
        lastUserInput: "super secret prompt",
      },
      [".env"],
      "/repo",
    );
    expect(e?.files).toEqual(["src/app.ts"]);
    expect(e?.ok).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/conv-secret-123|super secret|\.env/);
    expect(capture({ conversationId: "c", hookEventName: "Unknown" }, [])).toBeUndefined();
  });

  it("renders Antigravity views cleanly without touching Claude rules", async () => {
    const io = memoryIo({ ".claude/rules/archivist/core.md": "Claude" });
    io.target = "antigravity";
    const entries = new Map([["e", entry({ id: "e", type: "command", title: "Test", content: "npm test" })]]);
    await renderAll(io, entries, DEFAULT_CONFIG);
    expect(io.files.get(".claude/rules/archivist/core.md")).toBe("Claude");
    expect(io.files.get(".archivist/antigravity/rules/core.md")).toContain("npm test");
  });

  it("deduplicates PostToolUse events and injects core.md via injectSteps on SessionStart", async () => {
    const root = await mkdtemp(join(tmpdir(), "archivist-agy-hook-"));
    try {
      await uiInit(root);
      await uiAdd(root, { type: "command", title: "Build", content: "npm run build" });
      const toolInput = {
        conversationId: "conv-1",
        workspacePaths: [root],
        cwd: root,
        hookEventName: "PostToolUse",
        stepIdx: 2,
        toolCall: { id: "toolu_1", name: "run_command", args: { CommandLine: "npm test" } },
      };
      await Promise.all([handleHook(toolInput), handleHook(toolInput)]);
      const summary = JSON.parse(await collectionSummary(root));
      expect(summary.events).toBe(1);
      expect(await readFile(join(root, ".archivist/.gitignore"), "utf8")).toContain(".local/");

      const startOut = await handleHook({
        conversationId: "conv-1",
        workspacePaths: [root],
        cwd: root,
        hookEventName: "SessionStart",
      });
      const steps = startOut.injectSteps as { systemMessage: { systemMessage: string } }[];
      expect(steps).toHaveLength(1);
      expect(steps[0]!.systemMessage.systemMessage).toContain("npm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses agy JSON responses cleanly and reports auth requirement", () => {
    const wrapped = JSON.stringify({
      result: JSON.stringify({ summary: "Found gotcha", ops: [] }),
      usage: { input_tokens: 100, output_tokens: 40 },
    });
    const parsed = parseAgyReply(wrapped);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(JSON.parse(parsed.text).summary).toBe("Found gotcha");
      expect(parsed.usage.input).toBe(100);
    }
    expect(() => parseAgyReply("Authentication required. Please visit...")).toThrow(/login/);
  });

  it("queues tasks and runs background analysis into review queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "archivist-agy-queue-"));
    try {
      await writeFile(join(root, "src.ts"), "export const x = 1;\n");
      await uiInit(root);
      await uiAnalysis(root, "enable");
      const io = nodeIo(root, "antigravity");
      const config = { ...DEFAULT_CONFIG, antigravity: { ...DEFAULT_CONFIG.antigravity, enabled: true }, analyzer: { ...DEFAULT_CONFIG.analyzer, idleSeconds: 1, minToolCalls: 1 } };
      await captureTask(io, { conversationId: "conv-q", hookEventName: "PreInvocation", invocationNum: 1, lastUserInput: "Fix build script" }, config, 1000);
      await captureTask(io, { conversationId: "conv-q", hookEventName: "PostToolUse", stepIdx: 1, toolCall: { id: "c1", name: "run_command", args: { CommandLine: "npm test" } }, error: "exit 1" }, config, 1100);
      await captureTask(io, { conversationId: "conv-q", hookEventName: "PostToolUse", stepIdx: 2, toolCall: { id: "c2", name: "edit_file", args: { Path: join(root, "src.ts") } } }, config, 1200);
      await captureTask(io, { conversationId: "conv-q", hookEventName: "Stop", executionNum: 1 }, config, 1300);

      const statusBefore = await analysisStatus(io);
      expect(statusBefore.enabled).toBe(true);
      expect(statusBefore.tasks[0]?.state).toBe("pending");

      const taskFiles = await io.list(".archivist/.local/antigravity/tasks");
      const session = taskFiles[0]!.slice(0, -5);
      const fakeLlm = {
        async complete() {
          return {
            ok: true as const,
            text: JSON.stringify({
              summary: "Recorded build gotcha",
              ops: [
                {
                  op: "add",
                  type: "gotcha",
                  title: "Run build first",
                  content: "Run npm run build before tests.",
                  evidence: [{ file: "src.ts" }],
                  confidence: 0.95,
                },
              ],
            }),
            usage: { input: 500, output: 120 },
          };
        },
      };

      const ran = await processTask(io, session, fakeLlm, 10_000);
      expect(ran).toBe(true);
      const snap = await uiSnapshot({ root });
      expect(snap.counts.review).toBe(1);
      expect(snap.proposals[0]?.title).toBe("Run build first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports full Sidecar UI API lifecycle: register, init, add, settle, deprecate, maintenance, report", async () => {
    const root = await mkdtemp(join(tmpdir(), "archivist-agy-ui-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }));
      await uiRegisterProject(root, "conv-ui");
      const before = await uiSnapshot({ conversationId: "conv-ui" });
      expect(before.root).toBe(root);
      expect(before.initialized).toBe(false);

      const initRes = await uiInit(root);
      expect(initRes.root).toBe(root);

      const added = await uiAdd(root, {
        type: "decision",
        title: "Use Sidecar UI",
        content: "Render Archivist panel in Antigravity Auxiliary Pane.",
        rationale: "Native integration without external browser tab.",
      });
      expect(added.id).toBeTruthy();

      const io = nodeIo(root, "antigravity");
      await io.write(
        `${PATHS.proposals}/prop-1.json`,
        JSON.stringify({
          ts: new Date().toISOString(),
          op: { op: "add", type: "gotcha", title: "Sidecar port", content: "Use sidecar_sdk.", confidence: 0.9 },
          reason: "antigravity: review required",
        }) + "\n",
      );

      const snap = await uiSnapshot({ root });
      expect(snap.initialized).toBe(true);
      expect(snap.entries.some((e) => e.id === added.id)).toBe(true);
      expect(snap.proposals).toHaveLength(1);

      // Settle proposal with fingerprint protection
      const prop = snap.proposals[0]!;
      await expect(uiSettle(root, { id: prop.id, fingerprint: "wrong", action: "apply" })).rejects.toThrow();
      const settled = await uiSettle(root, { id: prop.id, fingerprint: prop.fingerprint, action: "apply" });
      expect(settled.text).toContain("принято");

      // Deprecate entry
      const dep = await uiDeprecate(root, { id: added.id, reason: "Test cleanup" });
      expect(dep.text).toContain("выведена");

      // Maintenance & report
      const lintRes = await uiMaintenance(root, "lint");
      expect(lintRes.text).toBeTruthy();
      const renderRes = await uiMaintenance(root, "render");
      expect(renderRes.text).toBeTruthy();
      const rep = await uiReport(root);
      expect(rep.text).toContain("Отчёт");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports console CLI commands via built plugin-antigravity/bin/archivist", async () => {
    const root = await mkdtemp(join(tmpdir(), "archivist-agy-cli-"));
    const cli = resolve("plugin-antigravity/bin/archivist");
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "cli-demo", scripts: { build: "tsc" } }));
      const env = { ...process.env, ARCHIVIST_ANTIGRAVITY_STATE: process.env.ARCHIVIST_ANTIGRAVITY_STATE };
      const initOut = await execFileAsync(process.execPath, [cli, "init", "--root", root], { env });
      expect(initOut.stdout).toContain("Archivist set up");

      await execFileAsync(process.execPath, [cli, "add", "--root", root, "--type", "gotcha", "--title", "CLI works", "--content", "Always use node 20+."], { env });
      const recallOut = await execFileAsync(process.execPath, [cli, "recall", "--root", root, "CLI works"], { env });
      expect(recallOut.stdout).toContain("CLI works");

      const statusOut = await execFileAsync(process.execPath, [cli, "status", "--root", root], { env });
      expect(statusOut.stdout).toContain("active entries");

      const analysisOut = await execFileAsync(process.execPath, [cli, "analysis", "status", "--root", root], { env });
      expect(JSON.parse(analysisOut.stdout).enabled).toBe(false);

      const collOut = await execFileAsync(process.execPath, [cli, "collection", "--root", root], { env });
      expect(JSON.parse(collOut.stdout).events).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
