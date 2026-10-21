import type { ProposedOp } from "../core/types.js";
import type { Feedback } from "../core/usage.js";

/** Finds the first balanced JSON object in a model reply (it may wrap it in prose or a code fence). */
export const extractJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced?.[1] ?? text;
  const start = src.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(src.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

export interface CuratorReply {
  summary: string;
  ops: ProposedOp[];
  feedback: Feedback[];
}

export const parseCuratorReply = (text: string): CuratorReply | undefined => {
  const json = extractJson(text) as { summary?: unknown; ops?: unknown; feedback?: unknown } | undefined;
  if (!json || typeof json !== "object") return undefined;
  const ops = Array.isArray(json.ops) ? (json.ops.filter((o) => o && typeof o === "object" && typeof (o as { op?: unknown }).op === "string") as ProposedOp[]) : [];
  const feedback = Array.isArray(json.feedback)
    ? (json.feedback as { id?: unknown; verdict?: unknown }[])
        .filter((f) => f && typeof f.id === "string" && (f.verdict === "helpful" || f.verdict === "harmful"))
        .map((f) => ({ id: f.id as string, verdict: f.verdict as Feedback["verdict"] }))
    : [];
  return { summary: typeof json.summary === "string" ? json.summary : "", ops, feedback };
};
