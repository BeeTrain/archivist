// A compact text of the task for the cheap model, when the full-context reflect is not available.
import { truncate } from "../core/text.js";
import type { Message, Segment } from "../core/types.js";

const toolLine = (t: { tool: string; input: Record<string, unknown>; isError?: boolean; text?: string }): string => {
  const i = t.input;
  const target = String(i.file_path ?? i.command ?? i.pattern ?? i.path ?? i.description ?? "");
  const err = t.isError ? ` ✗ ${truncate((t.text ?? "").replace(/\s+/g, " "), 200)}` : "";
  return `  · ${t.tool}(${truncate(target.replace(/\s+/g, " "), 160)})${err}`;
};

/** From the session's messages, starting at the task's first prompt. */
export const digestFromMessages = (messages: Message[], maxChars = 40_000): string => {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.text.trim()) out.push(`USER: ${truncate(m.text.trim(), 1500)}`);
    if (m.role === "assistant") {
      if (m.text.trim()) out.push(`AGENT: ${truncate(m.text.trim(), 800)}`);
      for (const t of m.toolUses ?? []) out.push(toolLine(t));
    }
  }
  let text = out.join("\n");
  // Keep the start (the ask) and the end (the outcome); cut the middle.
  if (text.length > maxChars) text = `${text.slice(0, maxChars * 0.4)}\n…\n${text.slice(-maxChars * 0.6)}`;
  return text;
};

/** From the adapter's journal alone (a task left over from an ended session). */
export const digestFromSegment = (seg: Segment): string => {
  const out: string[] = [];
  seg.prompts.forEach((p, i) => {
    out.push(`USER: ${truncate(p.trim(), 1500)}`);
    const a = seg.answers[i];
    if (a) out.push(`AGENT: ${truncate(a.trim(), 1200)}`);
  });
  for (const t of seg.tools) out.push(`  · ${t.tool}(${truncate(t.target ?? "", 160)})${t.ok ? "" : ` ✗ ${t.error ?? ""}`}`);
  return out.join("\n");
};

/** Finds where the task starts in the session's messages: the last user message that opens with its first prompt. */
export const sliceTask = (messages: Message[], firstPrompt: string | undefined, fallback = 200): Message[] => {
  if (firstPrompt) {
    const key = firstPrompt.trim().slice(0, 120);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "user" && m.text.trim().startsWith(key)) return messages.slice(i);
    }
  }
  return messages.slice(-fallback);
};
