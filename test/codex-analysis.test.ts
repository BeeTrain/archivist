import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nodeIo } from "../src/cli/node-io.js";
import { captureTask, processTask, analysisStatus, safeText, taskTool, runWorker } from "../src/adapters/codex/queue.js";
import { codexArgs, parseExecReply } from "../src/adapters/codex/llm.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { listProposals } from "../src/core/review.js";
import type { Llm } from "../src/core/io.js";
import { entry } from "./helpers.js";

const session = createHash("sha256").update("session").digest("hex").slice(0, 32);
const config = { ...DEFAULT_CONFIG, language: "Russian", codex: { ...DEFAULT_CONFIG.codex, enabled: true }, analyzer: { ...DEFAULT_CONFIG.analyzer, idleSeconds: 1, minToolCalls: 0 } };
const taskInput = { session_id: "session", turn_id: "turn" };
const reply: Llm = { complete: async () => ({ ok: true, text: JSON.stringify({ summary: "A durable pitfall", ops: [{ op: "add", type: "gotcha", title: "Migration requires explicit transaction", content: "Run schema changes inside an explicit transaction to prevent partially applied migration batches.", evidence: [{ file: "src/db.ts" }], confidence: 1 }], feedback: [] }), usage: { input: 100, output: 50 } }) };
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "archivist-analysis-test-"));
  const io = nodeIo(root, "codex");
  await io.write(".archivist/config.json", JSON.stringify(config));
  await io.write("src/db.ts", "export const migrate = () => {};\n");
  return { root, io, close: () => rm(root, { recursive: true, force: true }) };
};
const enqueue = async (io: ReturnType<typeof nodeIo>) => {
  await captureTask(io, { ...taskInput, hook_event_name: "UserPromptSubmit", prompt: "Fix partially applied database migrations" }, config, 1000);
  await captureTask(io, { ...taskInput, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: "*** Update File: src/db.ts\n+new" } }, config, 1100);
  await captureTask(io, { ...taskInput, hook_event_name: "Stop", last_assistant_message: "Explicit transaction fixed the migration" }, config, 2000);
};

describe("Codex background analysis", () => {
  it("defers until idle, writes proposals only and never repeats a completed task", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.io);
      expect(await processTask(ctx.io, session, reply, 2999)).toBe(false);
      expect(await processTask(ctx.io, session, reply, 3000)).toBe(true);
      expect((await loadState(ctx.io)).entries.size).toBe(0);
      expect(await listProposals(ctx.io)).toHaveLength(1);
      expect(await processTask(ctx.io, session, reply, 5000)).toBe(false);
      expect((await analysisStatus(ctx.io)).tasks[0]?.state).toBe("done");
    } finally { await ctx.close(); }
  });

  it("routes reinforcement of existing knowledge to review too", async () => {
    const ctx = await setup();
    try {
      const e = entry({ id: "a", type: "gotcha", title: "Transactions", content: "Use explicit transactions" });
      await appendLedger(ctx.io, [{ v: 1, ts: "2026-10-29", op: "add", entry: e }]);
      await enqueue(ctx.io);
      await processTask(ctx.io, session, { complete: async () => ({ ok: true, text: '{"summary":"Confirmed","ops":[{"op":"reinforce","id":"a"}],"feedback":[]}', usage: {} }) }, 3000);
      expect((await loadState(ctx.io)).entries.get("a")?.reinforced).toBe(0);
      expect((await listProposals(ctx.io))[0]?.op.op).toBe("reinforce");
    } finally { await ctx.close(); }
  });

  it("discards an obsolete result when a new prompt arrives during analysis", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.io);
      await processTask(ctx.io, session, { complete: async (r) => {
        await captureTask(ctx.io, { ...taskInput, turn_id: "new", hook_event_name: "UserPromptSubmit", prompt: "Continue fixing it" }, config, 3100);
        return reply.complete(r);
      } }, 3000);
      expect(await listProposals(ctx.io)).toHaveLength(0);
      expect((await analysisStatus(ctx.io)).tasks[0]?.state).toBe("collecting");
    } finally { await ctx.close(); }
  });

  it("retries errors after fifteen minutes and stops after three failures", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.io);
      const failed: Llm = { complete: async () => ({ ok: false, reason: "rate limit" }) };
      await processTask(ctx.io, session, failed, 3000);
      expect(await processTask(ctx.io, session, failed, 4000)).toBe(false);
      await processTask(ctx.io, session, failed, 903000);
      await processTask(ctx.io, session, failed, 1803000);
      expect((await analysisStatus(ctx.io)).tasks[0]?.state).toBe("failed");
      expect(await listProposals(ctx.io)).toHaveLength(0);
    } finally { await ctx.close(); }
  });

  it("keeps the daily call cap across restarts", async () => {
    const ctx = await setup();
    try {
      await ctx.io.write(".archivist/config.json", JSON.stringify({ ...config, codex: { ...config.codex, maxCallsPerDay: 0 } }));
      await enqueue(ctx.io);
      expect(await processTask(nodeIo(ctx.root, "codex"), session, reply, 3000)).toBe(false);
      expect((await analysisStatus(ctx.io)).tasks[0]?.state).toBe("postponed");
      expect(await listProposals(ctx.io)).toHaveLength(0);
    } finally { await ctx.close(); }
  });

  it("runs only one worker for concurrent launches and recovers a persisted task", async () => {
    const ctx = await setup();
    let calls = 0;
    try {
      await enqueue(ctx.io);
      const counted: Llm = { complete: async (r) => { calls++; return reply.complete(r); } };
      await Promise.all([runWorker(ctx.root, counted), runWorker(ctx.root, counted)]);
      expect(calls).toBe(1);
      expect(await listProposals(ctx.io)).toHaveLength(1);
      expect(await ctx.io.exists(".archivist/.local/codex/worker-lock")).toBe(false);
    } finally { await ctx.close(); }
  });

  it("ignores duplicate Stop, pauses on disable and skips tasks without a prompt", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.io);
      await captureTask(ctx.io, { ...taskInput, hook_event_name: "Stop" }, config, 5000);
      await ctx.io.write(".archivist/config.json", JSON.stringify({ ...config, codex: { ...config.codex, enabled: false } }));
      expect(await processTask(ctx.io, session, reply, 3000)).toBe(false);
      await ctx.io.write(".archivist/config.json", JSON.stringify(config));
      expect(await processTask(ctx.io, session, reply, 3000)).toBe(true);
      await captureTask(ctx.io, { ...taskInput, turn_id: "empty", hook_event_name: "UserPromptSubmit" }, config, 6000);
      await captureTask(ctx.io, { ...taskInput, turn_id: "empty", hook_event_name: "Stop" }, config, 7000);
      await processTask(ctx.io, session, { complete: async () => { throw new Error("Must not call model"); } }, 8000);
      expect((await analysisStatus(ctx.io)).tasks[0]?.message).toContain("Недостаточно контекста");
    } finally { await ctx.close(); }
  });

  it("redacts secrets and omits excluded paths and patch contents", () => {
    expect(safeText("API_KEY=abcdefghijk\nread secrets/keys.txt\nkeep this line", ["secrets/**"], "/project")).toBe("API_KEY=[redacted]\nkeep this line");
    const tools = taskTool({ tool_name: "apply_patch", tool_input: { command: "*** Update File: src/db.ts\n+password=hidden\n*** Update File: .env\n+token=secret" } }, config, "/project");
    expect(tools).toEqual([{ tool: "Edit", target: "src/db.ts", ok: true }]);
    expect(taskTool({ tool_name: "exec_command", tool_input: { cmd: "npm test" }, tool_response: { exit_code: 1, output: "password=abcdefgh" } }, config, "/project")[0]).toMatchObject({ tool: "Bash", ok: false, error: "password=[redacted]" });
  });

  it("isolates the child and rejects unexpected tools and malformed output", () => {
    const args = codexArgs("/tmp/probe", config.codex);
    expect(args).toContain("--ignore-user-config");
    for (const feature of ["hooks", "plugins", "shell_tool", "multi_agent"]) expect(args).toContain(feature);
    const output = [
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ result: '{"summary":"nothing","ops":[]}' }) } },
      { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 5 } },
    ].map((e) => JSON.stringify(e)).join("\n");
    expect(parseExecReply(output)).toMatchObject({ ok: true, usage: { input: 100, cacheRead: 20, output: 5 } });
    expect(() => parseExecReply('{"type":"item.completed","item":{"type":"command_execution"}}')).toThrow("Unexpected tool");
    expect(() => parseExecReply('{"type":"turn.failed"}')).toThrow();
    expect(() => parseExecReply("{}")).toThrow("Incomplete");
  });
});
