import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { appendLedger, loadState } from "../src/core/ledger.js";
import { listProposals } from "../src/core/review.js";
import { renderAll } from "../src/core/render.js";
import { emptyUsage } from "../src/core/types.js";
import { nodeIo, uninstall } from "../src/cli/node-io.js";
import { captureTool } from "../src/adapters/opencode/capture.js";
import { analysisModel, opencodeLlm } from "../src/adapters/opencode/llm.js";
import { Collector, tasks } from "../src/adapters/opencode/queue.js";
import { knowledge } from "../src/adapters/opencode/knowledge.js";
import { analysisCommand, runCommand } from "../src/adapters/opencode/commands.js";
import { setup as setupPlugin } from "../src/adapters/opencode/index.js";
import { entry, memoryIo } from "./helpers.js";
import type { Llm } from "../src/core/io.js";

const config = { ...DEFAULT_CONFIG, language: "Russian", analyzer: { ...DEFAULT_CONFIG.analyzer, idleSeconds: 1, minToolCalls: 0 } };
const model = { providerID: "test", id: "model" };
const reply: Llm = { complete: async () => ({ ok: true, text: JSON.stringify({ summary: "Durable lesson", ops: [{ op: "add", type: "gotcha", title: "Migration requires explicit transaction", content: "Run schema changes inside an explicit transaction to prevent partially applied migration batches.", evidence: [{ file: "src/db.ts" }], confidence: 1 }], feedback: [] }), usage: { input: 100, output: 50 } }) };
const setup = async (llm = reply) => {
  const root = await mkdtemp(join(tmpdir(), "archivist-opencode-test-"));
  const io = nodeIo(root, "opencode");
  await io.write(".archivist/config.json", JSON.stringify(config));
  await io.write("src/db.ts", "export const migrate = () => {};\n");
  const collector = new Collector(io, () => llm);
  return { root, io, collector, close: async () => { collector.close(); await rm(root, { recursive: true, force: true }); } };
};
const enqueue = async (collector: Collector, session = "private-session") => {
  await collector.prompt(session, "prompt-1", "Fix partially applied database migrations", 1000);
  await collector.tool(session, "tool-1", { tool: "edit", input: { filePath: "src/db.ts", newString: "API_KEY=abcdefghij" }, status: "completed" });
  await collector.answer(session, "answer-1", "Use explicit transactions");
  await collector.step(session, "step-1", emptyUsage(), model);
  await collector.idle(session, model, 2000);
};

describe("OpenCode 2.2.5", () => {
  it("normalizes paths, failed commands and patches without collecting file contents", () => {
    expect(captureTool({ tool: "read", input: { filePath: "/project/.env" }, status: "completed" }, "/project", config)).toEqual([]);
    expect(captureTool({ tool: "edit", input: { filePath: "../outside" }, status: "completed" }, "/project", config)).toEqual([]);
    expect(captureTool({ tool: "read", input: { filePath: "/project/src/db.ts" }, status: "completed" }, "/project", config)).toEqual([{ tool: "Read", target: "src/db.ts", ok: true }]);
    expect(captureTool({ tool: "apply_patch", input: { patchText: "*** Update File: src/db.ts\n+API_KEY=abcdefghij\n*** Add File: .env\n*** Delete File: ../outside" }, status: "completed" }, "/project", config)).toEqual([{ tool: "Edit", target: "src/db.ts", ok: true }]);
    expect(captureTool({ tool: "bash", input: { command: "npm test" }, status: "completed", result: { metadata: { exit: 1 } } }, "/project", config)).toEqual([{ tool: "Bash", target: "npm test", ok: false, error: "Exit code: 1" }]);
    expect(captureTool({ tool: "bash", input: { command: "npm test" }, status: "error", error: { message: "password=abcdefghij" } }, "/project", config)[0]?.error).toBe("password=[redacted]");
    expect(captureTool({ tool: "archivist", input: {}, status: "completed" }, "/project", config)).toEqual([]);
  });

  it("isolates generated rules and skills from Claude and Codex, including uninstall", async () => {
    const ctx = await setup();
    try {
      await ctx.io.write(".claude/rules/archivist/core.md", "Claude");
      await ctx.io.write(".archivist/codex/rules/core.md", "Codex");
      await ctx.io.write(".agents/skills/archivist-build/SKILL.md", "Codex skill");
      const entries = new Map([
        ["g", entry({ id: "g", type: "gotcha", title: "Transactions", content: "Use explicit transactions" })],
        ["p", entry({ id: "p", type: "procedure", title: "Build workflow", content: "Run build then inspect the output" })],
      ]);
      await appendLedger(ctx.io, [...entries.values()].map((entry) => ({ v: 1, ts: entry.created, op: "add", entry })));
      await renderAll(ctx.io, entries, config);
      expect(await ctx.io.read(".archivist/opencode/rules/core.md")).toContain("Use explicit transactions");
      expect(await ctx.io.read(".opencode/skills/archivist-build-workflow/SKILL.md")).toContain("Run build");
      await uninstall(ctx.root, false, "opencode");
      expect(await ctx.io.exists(".archivist/opencode/rules/core.md")).toBe(false);
      expect(await ctx.io.read(".claude/rules/archivist/core.md")).toBe("Claude");
      expect(await ctx.io.read(".archivist/codex/rules/core.md")).toBe("Codex");
      expect(await ctx.io.read(".agents/skills/archivist-build/SKILL.md")).toBe("Codex skill");
      expect((await loadState(ctx.io)).entries.size).toBe(2);
    } finally { await ctx.close(); }
  });

  it("injects bounded scoped knowledge and excludes stale evidence", async () => {
    const io = memoryIo({ "src/db.ts": "exists" });
    const entries = [
      entry({ id: "c", type: "command", title: "Test", content: "npm test" }),
      entry({ id: "g", type: "gotcha", title: "Transactions", content: "Use explicit transactions", scope: { paths: ["src/**"] } }),
      entry({ id: "s", type: "gotcha", title: "Old fact", content: "Unusable old knowledge", evidence: [{ file: "gone.ts" }] }),
    ];
    await appendLedger(io, entries.map((entry) => ({ v: 1, ts: entry.created, op: "add", entry })));
    expect(await knowledge(io)).toContain("npm test");
    expect(await knowledge(io)).not.toContain("Use explicit transactions");
    expect(await knowledge(io, ["src/db.ts"])).toContain("Use explicit transactions");
    expect(await knowledge(io, ["src/db.ts"])).not.toContain("Unusable old knowledge");
    expect((await knowledge(io, ["src/db.ts"])).length).toBeLessThan(10000);
  });

  it("recovers persisted tasks, deduplicates events and sends every operation to review", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.collector);
      await enqueue(ctx.collector);
      expect((await tasks(ctx.io))[0]?.segment.tools).toHaveLength(1);
      expect((await tasks(ctx.io))[0]?.due).toBe(3000);
      const restarted = new Collector(nodeIo(ctx.root, "opencode"), () => reply);
      expect(await restarted.process("private-session", 2999)).toBe(false);
      expect(await restarted.process("private-session", 3000)).toBe(true);
      expect((await loadState(ctx.io)).entries.size).toBe(0);
      expect(await listProposals(ctx.io)).toHaveLength(1);
      expect(await restarted.process("private-session", 4000)).toBe(false);
      expect(await ctx.io.read(".archivist/.gitignore")).toContain(".local/");
      const proposal = (await listProposals(ctx.io))[0]!;
      expect(await ctx.io.read(proposal.path)).not.toMatch(/private-session|API_KEY|abcdefghij/);
      restarted.close();
    } finally { await ctx.close(); }
  });

  it("does not analyze while OpenCode is busy and discards results superseded by a prompt", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.collector);
      expect(await ctx.collector.process("private-session", 3000, async () => false)).toBe(false);
      const next = new Collector(ctx.io, () => ({ complete: async (request) => {
        await ctx.collector.prompt("private-session", "new-prompt", "Continue the migration", 3100);
        return reply.complete(request);
      } }));
      expect(await next.process("private-session", 3000)).toBe(true);
      expect(await listProposals(ctx.io)).toHaveLength(0);
      expect((await tasks(ctx.io))[0]?.state).toBe("collecting");
      expect((await tasks(ctx.io))[0]?.due).toBeNull();
      next.close();
    } finally { await ctx.close(); }
  });

  it("claims one analyzer lease across plugin instances", async () => {
    let calls = 0;
    const ctx = await setup({ complete: async (request) => { calls++; return reply.complete(request); } });
    const other = new Collector(ctx.io, () => ({ complete: async (request) => { calls++; return reply.complete(request); } }));
    try {
      await enqueue(ctx.collector);
      await Promise.all([ctx.collector.process("private-session", 3000), other.process("private-session", 3000)]);
      expect(calls).toBe(1);
      expect(await listProposals(ctx.io)).toHaveLength(1);
    } finally { other.close(); await ctx.close(); }
  });

  it("keeps budgets across reloads and respects explicit disable", async () => {
    const ctx = await setup();
    try {
      await enqueue(ctx.collector);
      await ctx.io.write(".archivist/config.json", JSON.stringify({ ...config, opencode: { ...config.opencode, maxCallsPerDay: 0 } }));
      expect(await ctx.collector.process("private-session", 3000)).toBe(false);
      expect((await tasks(ctx.io))[0]?.state).toBe("postponed");
      expect((await tasks(ctx.io))[0]?.due).toBe(903000);
      expect(await analysisCommand(ctx.io, "disable")).toContain("disabled");
      await ctx.collector.prompt("private-session", "ignored", "Must not be captured");
      expect(JSON.stringify(await tasks(ctx.io))).not.toContain("Must not be captured");
      expect(await ctx.collector.process("private-session", 1000000)).toBe(false);
    } finally { await ctx.close(); }
  });

  it("retries model failures after fifteen minutes and stops after three attempts", async () => {
    const ctx = await setup({ complete: async () => ({ ok: false, reason: "rate limited" }) });
    try {
      await enqueue(ctx.collector);
      await ctx.collector.process("private-session", 3000);
      expect(await ctx.collector.process("private-session", 3001)).toBe(false);
      await ctx.collector.process("private-session", 903000);
      await ctx.collector.process("private-session", 1803000);
      expect((await tasks(ctx.io))[0]?.state).toBe("failed");
    } finally { await ctx.close(); }
  });

  it("uses the installed V2 stateless generation contract, with model selection and cancellation", async () => {
    const generate = vi.fn(async () => ({ text: '{"summary":"Nothing","ops":[]}' }));
    const controller = new AbortController();
    const llm = opencodeLlm(generate as Context["experimental"]["generate"]["text"], config.opencode, model, controller.signal);
    const result = await llm.complete({ system: "Instructions", prompt: "Evidence", maxTokens: 2500 });
    expect(result.ok).toBe(true);
    expect(generate.mock.calls[0]).toEqual([{ model, prompt: expect.stringContaining("Evidence") }, { signal: controller.signal }]);
    expect(analysisModel("provider/model/with/slashes", model)).toEqual({ providerID: "provider", id: "model/with/slashes" });
    expect(() => analysisModel("haiku", model)).toThrow("provider/model");
    const noModel = opencodeLlm(generate as Context["experimental"]["generate"]["text"], config.opencode, undefined, controller.signal);
    expect(await noModel.complete({ system: "", prompt: "", maxTokens: 1 })).toMatchObject({ ok: false });
  });

  it("does not let plugin commands redirect the shared CLI or start long-running commands", async () => {
    const io = memoryIo();
    for (const command of ["recall test --root /elsewhere", "status --target=claude", "panel", "uninstall", "baseline"])
      await expect(runCommand(io, command, "unused")).rejects.toThrow("current project");
  });

  it("registers the V2 plugin and schedules analysis on the actual execution.succeeded event", async () => {
    const ctx = await setup();
    const hooks = new Map<string, (event: any) => Promise<void>>();
    const registered: Record<string, any[]> = { tools: [], skills: [], commands: [] };
    let deliver: (value: any) => void = () => {};
    let subscribed: string[] = [];
    const fake = {
      rpc: { register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }) },
      location: { directory: ctx.root },
      experimental: { generate: { text: vi.fn() } },
      skill: { transform: async (callback: any) => callback({ add: (skill: any) => registered.skills!.push(skill) }), reload: async () => {} },
      tool: { transform: async (callback: any) => callback({ add: (tool: any) => registered.tools!.push(tool) }), hook: async (name: string, fn: any) => { hooks.set(`tool:${name}`, fn); } },
      command: { transform: async (callback: any) => callback({ add: (command: any) => registered.commands!.push(command) }) },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: sessionID === "foreign" ? join(ctx.root, "other") : ctx.root }, time: { busy: 1, idle: 2 } }),
        context: async () => [{ type: "user", id: "msg_user", text: "Fix the database migration" }],
        hook: async (name: string, fn: any) => { hooks.set(`session:${name}`, fn); },
        synthetic: vi.fn(),
      },
      event: { subscribe: ({ signal, types }: { signal: AbortSignal; types: string[] }) => {
        subscribed = types;
        return { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => {
          deliver = (value) => resolve({ value, done: false });
          signal.addEventListener("abort", () => resolve({ done: true }), { once: true });
        }) }) };
      } },
    } as unknown as Context;
    const close = await setupPlugin(fake, resolve("plugin-opencode"));
    try {
      expect(registered.skills?.map((skill) => skill.name)).toContain("archivist-triage");
      expect(subscribed).toContain("session.execution.succeeded");
      const event = { sessionID: "session", system: [], model };
      await hooks.get("session:context")!(event);
      expect(JSON.stringify(event.system)).toContain("Project knowledge");
      expect((await tasks(ctx.io))[0]?.model).toEqual(model);
      await hooks.get("tool:execute.after")!({ sessionID: "session", id: "tool", tool: "edit", input: { filePath: "src/db.ts" }, status: "completed" });
      deliver({ type: "session.execution.succeeded", id: "evt_done", data: { sessionID: "session" } });
      await vi.waitFor(async () => expect((await tasks(ctx.io))[0]?.state).toBe("pending"));
      const foreign = { sessionID: "foreign", system: [], model };
      await hooks.get("session:context")!(foreign);
      expect(foreign.system).toEqual([]);
      await expect(registered.tools![0].execute({ command: "status" }, { sessionID: "foreign" })).rejects.toThrow("only in its project");
      await hooks.get("session:prompt")!({ sessionID: "session" });
      expect((await tasks(ctx.io))[0]?.due).toBeNull();
    } finally { close(); await ctx.close(); }
  });
});
