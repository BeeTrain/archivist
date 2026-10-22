import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CURATE_SYSTEM } from "../src/analyzer/prompts.js";

const skill = (name: string) => readFileSync(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url), "utf8");

describe("only knowledge of this project", () => {
  it("the curator leaves out machine setup, other repositories and what tools enforce", () => {
    expect(CURATE_SYSTEM).toContain("Only knowledge of THIS project");
    expect(CURATE_SYSTEM).toContain("never what tools already enforce without the agent");
  });

  it("triage skips such proposals itself, decisions included, before asking the user anything", () => {
    const triage = skill("triage");
    expect(triage).toContain("Before asking anything, skip yourself, decisions included, whatever is not knowledge of this project");
    expect(triage.indexOf("Before asking anything")).toBeLessThan(triage.indexOf("are the user's"));
  });

  it("remember and decide decline it when asked by hand", () => {
    expect(skill("remember")).toContain("global git config");
    expect(skill("decide")).toContain("Only decisions about this project");
  });
});
