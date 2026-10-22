import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CURATE_SYSTEM } from "../src/analyzer/prompts.js";
import { addEntry } from "../src/core/review.js";
import { ticketRef } from "../src/core/text.js";
import type { ProposedOp } from "../src/core/types.js";
import { validateOps } from "../src/core/validate.js";
import { config, memoryIo } from "./helpers.js";

const ts = "2026-10-22T10:00:00.000Z";

describe("ticket references", () => {
  it("finds a ticket, also inside a branch name, and leaves standards alone", () => {
    expect(ticketRef("Пачка пишется в ветку `tech/ADANDTECH-2542-uitests`")).toBe("ADANDTECH-2542");
    expect(ticketRef("fixes PROJ-12 in the parser")).toBe("PROJ-12");
    expect(ticketRef("Read files as UTF-8, hash with SHA-256, dates in ISO-8601 per RFC-3339")).toBeUndefined();
    expect(ticketRef("Run `npm test` before a commit")).toBeUndefined();
  });
});

describe("entries tied to the task at hand", () => {
  const branches: ProposedOp = {
    op: "add",
    type: "gotcha",
    title: "Пачки в отдельных ветках",
    content: "Каждая пачка пишется в ветку `tech/ADANDTECH-2542-<n>` и после приёмки сливается локально.",
    confidence: 0.95,
  };

  it("are never applied unattended, even on a repeat, and say why", async () => {
    const v = await validateOps({ ops: [branches], entries: new Map(), io: memoryIo(), config: config(), docs: [], now: ts, pending: [{ id: "p-0", op: branches }] });
    expect(v.records).toHaveLength(0);
    expect(v.promoted).toEqual([]);
    expect(v.proposals[0]?.reason).toBe("tied to ticket ADANDTECH-2542");
  });

  it("are still recorded when the user adds one by hand", async () => {
    const out = await addEntry(memoryIo(), config(), { type: "gotcha", title: "Ветка эпика", content: "Работаем в `tech/ADANDTECH-2542-uitests`" }, ts);
    expect(out[0]).toMatchObject({ type: "gotcha", reason: "tied to ticket ADANDTECH-2542" });
    expect(out[0]?.id).toBeDefined();
  });

  it("are kept out by the curator and reduced to their lasting part by triage", () => {
    expect(CURATE_SYSTEM).toContain("Never tie an entry to the task at hand");
    const triage = readFileSync(new URL("../plugin/skills/triage/SKILL.md", import.meta.url), "utf8");
    expect(triage).toContain("keep only the part that outlives the task");
    expect(triage).toContain("offered only in its lasting form");
  });
});
