import type { Context } from "@opencode/plugin/promise/plugin";
import type { Skill } from "@opencode/schema/skill";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const registerSkills = async (ctx: Context, directory: string) => {
  const skills = await Promise.all(["recall", "remember", "decide", "triage"].map(async (name) => {
    const path = join(directory, "skills", name, "SKILL.md");
    const text = await readFile(path, "utf8");
    const description = JSON.parse(text.match(/^description: (.+)$/m)![1]!);
    const content = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const id = `archivist-${name}`;
    return { id, name: id, description, content, path } as Skill.Info;
  }));
  return ctx.skill.transform((editor) => { for (const skill of skills) editor.add(skill); });
};
