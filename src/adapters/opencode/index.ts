import { define, type Context } from "@opencode/plugin/promise/plugin";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot, nodeIo } from "../../cli/node-io.js";
import { loadConfig } from "../../core/config.js";
import { withLock } from "../../core/lock.js";
import { loadState } from "../../core/ledger.js";
import { renderAll } from "../../core/render.js";
import { runCommand } from "./commands.js";
import { knowledge } from "./knowledge.js";
import { opencodeLlm } from "./llm.js";
import { Collector, tasks } from "./queue.js";
import { registerSkills } from "./skills.js";
import { ArchivistRpc } from "./rpc.js";
import { settleProposal, uiReport, uiSnapshot } from "./snapshot.js";

export const setup = async (ctx: Context, packageDirectory = fileURLToPath(new URL(".", import.meta.url))) => {
  const directory = resolve(ctx.location.directory);
  const io = nodeIo(findRoot(directory), "opencode");
  const collector = new Collector(io, (config, model, signal) => opencodeLlm(ctx.experimental.generate.text, config.opencode, model, signal));
  const controller = new AbortController();
  const cli = join(packageDirectory, "bin/archivist");
  let eventWork: Promise<void> = Promise.resolve();
  let pumping = false;
  const failure = () => { console.error("Archivist: OpenCode operation failed; check /archivist analysis status."); };
  const session = async (sessionID: string) => {
    const info = await ctx.session.get({ sessionID });
    return resolve(info.location.directory) === directory && !info.parentID ? info : undefined;
  };
  const idle = async (sessionID: string) => {
    const info = await session(sessionID);
    return !!info && info.time.idle !== undefined && info.time.idle >= (info.time.busy ?? 0);
  };
  const render = async () => {
    const config = await loadConfig(io);
    if (config.enabled && await io.exists(".archivist/ledger.jsonl"))
      await withLock(io, async () => { await renderAll(io, (await loadState(io)).entries, config); });
  };
  const execute = async (command: string) => {
    const output = await runCommand(io, command, cli);
    await render();
    await ctx.skill.reload();
    return output;
  };
  await ctx.rpc.register(ArchivistRpc, {
    snapshot: async (raw) => {
      const input = raw as { sessionID: string; query?: string };
      if (!(await session(input.sessionID))) throw new Error("Archivist is unavailable in this session");
      return uiSnapshot(io, input.sessionID, input.query);
    },
    report: async (raw) => {
      const input = raw as { sessionID: string };
      if (!(await session(input.sessionID))) throw new Error("Archivist is unavailable in this session");
      return uiReport(io, input.sessionID);
    },
    settle: async (raw) => {
      const input = raw as { sessionID: string; id: string; fingerprint: string; action: "apply" | "skip" };
      if (!(await session(input.sessionID))) throw new Error("Archivist is unavailable in this session");
      const result = await settleProposal(io, input);
      await ctx.skill.reload();
      return result;
    },
  });
  await registerSkills(ctx, packageDirectory);
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "archivist",
      description: "Project memory shared across coding agents. Before exploring use recall <query>. Commands: init, status, recall, add --type command|gotcha|decision --title <text> --content <text> [--why <reason>], edit, review [--json], apply <ids>, skip <ids>, render, doctor, analysis status|enable|disable. Quote arguments with spaces. Save only durable facts; decisions need the user's settled choice and its reasons.",
      input: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      options: { codemode: false },
      execute: async (input, context) => {
        if (!(await session(context.sessionID))) throw new Error("Archivist is available only in its project and root session");
        return { content: await execute((input as { command: string }).command) };
      },
    });
  });
  await ctx.command.transform((editor) => {
    editor.add({ name: "archivist", description: "Знания проекта, поиск и очередь ревью", execute: async ({ sessionID, prompt }) => {
      if (!(await session(sessionID))) return;
      const text = await execute(prompt.text);
      await ctx.session.synthetic({ sessionID, text, description: "Archivist", metadata: { archivist: true }, resume: false });
    } });
  });
  await ctx.session.hook("prompt", async (event) => {
    try {
      if (await session(event.sessionID)) await collector.invalidate(event.sessionID);
    } catch { failure(); }
  });
  await ctx.session.hook("context", async (event) => {
    try {
      await eventWork;
      if (!(await session(event.sessionID))) return;
      const messages = await ctx.session.context({ sessionID: event.sessionID });
      const latest = [...messages].reverse().find((message) => message.type === "user");
      if (latest?.type === "user") await collector.prompt(event.sessionID, latest.id, latest.text);
      await collector.model(event.sessionID, event.model);
      const task = (await tasks(io)).find((task) => task.sessionID === event.sessionID);
      const touched = task?.segment.tools.filter((tool) => tool.tool === "Read" || tool.tool === "Edit").flatMap((tool) => tool.target ? [tool.target] : []) ?? [];
      const text = await knowledge(io, touched);
      if (text) event.system.push({ type: "text", text });
    } catch { failure(); }
  });
  await ctx.tool.hook("execute.after", async (event) => {
    try {
      await eventWork;
      if (event.tool !== "archivist" && await session(event.sessionID)) await collector.tool(event.sessionID, event.id, event);
    } catch { failure(); }
  });
  const consume = async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal, types: ["session.inbox.enqueued", "session.text.ended", "session.step.ended", "session.idle", "session.execution.succeeded", "session.execution.interrupted", "session.execution.failed", "session.deleted", "session.moved"] })) {
      eventWork = eventWork.then(async () => {
        const id = event.data.sessionID;
        if (event.type === "session.deleted" || event.type === "session.moved") {
          await collector.remove(id);
          return;
        }
        const info = await session(id);
        if (!info) return;
        if (event.type === "session.inbox.enqueued" && event.data.item.type === "user")
          await collector.prompt(id, event.data.inboxID, event.data.item.payload.text);
        else if (event.type === "session.text.ended") await collector.answer(id, event.id, event.data.text);
        else if (event.type === "session.step.ended") {
          const u = event.data.tokens;
          await collector.step(id, event.id, { input: u.input, output: u.output + u.reasoning, cacheRead: u.cache.read, cacheWrite: u.cache.write }, info.model);
        } else if (event.type === "session.idle" || event.type === "session.execution.succeeded") await collector.idle(id, info.model);
        else if (event.type === "session.execution.interrupted" || event.type === "session.execution.failed") await collector.invalidate(id);
      }).catch(failure);
    }
    if (!controller.signal.aborted) throw new Error("Event stream ended");
  };
  const stream = async () => {
    while (!controller.signal.aborted) {
      try { await consume(); } catch { if (!controller.signal.aborted) failure(); }
      if (!controller.signal.aborted) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 5000);
        controller.signal.addEventListener("abort", done, { once: true });
      });
    }
  };
  void stream();
  const pump = async () => {
    if (pumping || controller.signal.aborted) return;
    pumping = true;
    try {
      await eventWork;
      for (const task of await tasks(io)) {
        if (controller.signal.aborted) break;
        if (task.due !== null && task.due <= Date.now()) await collector.process(task.sessionID, Date.now(), () => idle(task.sessionID));
      }
    } catch { failure(); } finally { pumping = false; }
  };
  const timer = setInterval(() => { void pump(); }, 1000);
  timer.unref();
  await render();
  return () => {
    controller.abort();
    collector.close();
    clearInterval(timer);
  };
};

export default define({ id: "archivist", setup });
