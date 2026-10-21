import { truncate } from "../core/text.js";
import type { Entry } from "../core/types.js";

/**
 * Asked of the main model over its own cached transcript ($.model.fork). It saw the whole task, including
 * why things were decided, so it extracts; the cheap curator then turns notes into ops.
 */
const languageRule = (language: string, auto: string): string => (language === "auto" ? auto : `write in ${language}`);

export const reflectPrompt = (firstPrompt: string | undefined, language = "auto", entries: Entry[] = []): string =>
  [
    "[Archivist plugin — a side question, not a task. Do not continue the work and do not call tools.]",
    "",
    firstPrompt
      ? `Look ONLY at the most recent task: the messages from the user's request «${truncate(firstPrompt.trim(), 300)}» to now. Earlier work in this session is not part of it: leave it out even if it was instructive.`
      : "Look ONLY at the most recent task in this session; leave earlier work out.",
    "List only what would save time, tokens or context in FUTURE tasks in this project and that cannot be quickly derived from the code itself:",
    "",
    "COMMANDS: exact commands (build, test, lint, run, generate) that turned out to be right, especially after wrong attempts.",
    "GOTCHAS: pitfalls and non-obvious constraints you hit: where (file or path) and how to avoid them.",
    "DECISIONS: decisions made in this task: what was chosen, why, which alternatives were rejected; with files.",
    "WASTE: where steps or tokens were wasted, and which single note would have prevented it.",
    "PROCEDURE: if the task followed a multi-step workflow likely to recur (release, migration, adding an endpoint), its steps in order; else «—».",
    ...(entries.length
      ? [
          "ENTRIES: these notes from earlier sessions were available. Name the ids you actually relied on (USED) and any that were wrong or misled you (WRONG), with one reason each:",
          ...entries.map((e) => `  ${e.id}: ${e.title}`),
        ]
      : []),
    "",
    "Rules: short bullets; give a file path as evidence when there is one; invent nothing; write «—» for an empty section;",
    `no secrets, tokens or personal data; no overview of the codebase; at most 25 lines; ${languageRule(language, "write in the language of the user's request")}.`,
  ].join("\n");

export const CURATE_SYSTEM = [
  "You curate a small knowledge base that an AI coding agent reads at the start of every session in one project.",
  "Every line it reads costs tokens in every future session, and agents follow everything written, so be strict:",
  "- Keep only facts the agent cannot derive quickly from the code: exact commands, non-obvious pitfalls, decisions with their reasons.",
  "- Never write overviews, directory structure, generic best practices, or anything already in the existing project docs.",
  "- Never record one-off operations the task already finished (creating a repo, setting up credentials, rewriting a commit): only what a future task will need again.",
  "- Never record temporary state or to-dos (\"revert X after the test\", \"not run yet\", \"until phase 4\"): only facts that stay true.",
  "- One atomic fact per entry: two facts are two entries, never one with a joint title.",
  "- title: ≤ 8 words naming the fact. content: 1–2 lines, imperative, concrete (exact command, path, flag); it must not repeat the title.",
  "- Prefer reinforcing or updating an existing entry over adding a near-duplicate.",
  "- Deprecate an existing entry only when the notes clearly contradict it.",
  "- A decision needs a rationale (why, and what was rejected). Its content starts with the rule itself in one sentence: that sentence is what every session reads.",
  "- scope.paths: set it for any entry, a decision too, that only matters when working on part of the code; it then loads only there.",
  "- confidence: 0.9+ only for facts directly confirmed in the task (a command that ran, a decision the user approved); 0.5–0.7 for plausible but unverified; below 0.5 do not propose.",
  "- Most tasks teach nothing durable: then return no ops.",
  "- procedure: only for a multi-step workflow that is likely to recur; content is its numbered steps (exact commands), rationale is one full sentence saying when to use it (\"Use when cutting a release.\").",
  "- feedback: for existing entries the notes say were USED (helpful) or WRONG (harmful). Never guess: no mention, no feedback.",
  "",
  "Answer with ONE JSON object and nothing else:",
  '{"summary": "<one line: what this task taught, or why nothing>",',
  ' "ops": [',
  '  {"op":"add","type":"command|gotcha|decision|procedure","title":"<≤8 words>","content":"<1–2 lines; numbered steps for a procedure>","rationale":"<why for a decision; for a procedure, one sentence saying when to use it>",',
  '   "scope":{"paths":["src/db/**"]},"evidence":[{"file":"<project-relative path>","anchor":"<script/symbol/heading>"}],',
  '   "confidence":0.0,"supersedes":["<id>"],"savings":{"toolCalls":0,"tokens":0}},',
  '  {"op":"update","id":"<id>","content":"<new content>","confidence":0.0},',
  '  {"op":"reinforce","id":"<id>"},',
  '  {"op":"deprecate","id":"<id>","reason":"<why>","confidence":0.0}',
  " ],",
  ' "feedback": [{"id":"<id>","verdict":"helpful|harmful"}]}',
  "Omit optional fields you have nothing for. savings: your estimate of tool calls and tokens a future similar task saves.",
  "Write titles and content in the language of the notes.",
].join("\n");

export const curatePrompt = (args: { notes: string; notesKind: "reflection" | "digest"; signals: string; candidates: Entry[]; language?: string }): string => {
  const existing = args.candidates.length
    ? args.candidates.map((e) => `- ${e.id} [${e.type}] ${e.title}: ${e.content.replace(/\n/g, " ")}`).join("\n")
    : "(none yet)";
  return [
    ...(args.language && args.language !== "auto" ? [`LANGUAGE: write titles, content and rationale in ${args.language}.`, ""] : []),
    "EXISTING ENTRIES (most relevant):",
    existing,
    "",
    "TASK SIGNALS (measured):",
    args.signals,
    "",
    args.notesKind === "reflection" ? "NOTES FROM THE AGENT THAT DID THE TASK:" : "TASK DIGEST (messages and tool calls):",
    args.notes,
  ].join("\n");
};
