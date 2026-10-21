import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/core/config.js";
import { renderAreas, renderCore } from "../src/core/render.js";
import { entry } from "./helpers.js";

const cfg = (over: Partial<Config["budgets"]> = {}, decisions: "compact" | "full" = "compact"): Config => ({
  ...DEFAULT_CONFIG,
  budgets: { ...DEFAULT_CONFIG.budgets, ...over },
  rules: { decisions },
});

const decision = entry({
  id: "dec-1",
  type: "decision",
  adr: 17,
  title: "Документация проекта на русском",
  content: "README, PLAN.md и docs/ пишутся на русском. Код, комментарии и сообщения коммитов — на английском, как принято в экосистеме.",
  rationale: "Остальная документация на русском.",
});
const scopedDecision = entry({
  id: "dec-2",
  type: "decision",
  adr: 2,
  title: "Один ключ хранилища на задачу",
  content: "Ключ `archivist:seg:<session>:<segId>` на каждую задачу; общий ключ затирал задачу, ожидающую анализа.",
  scope: { paths: ["src/adapters/claude/mod/**"] },
});

describe("decisions in rule files", () => {
  it("are compact in core.md: the rule sentence, with the full text one ADR away", () => {
    const core = renderCore([decision], cfg());
    expect(core).toContain("- ADR-0017 **Документация проекта на русском**: README, PLAN.md и docs/ пишутся на русском.\n");
    expect(core).not.toContain("сообщения коммитов");
    expect(core).toContain("Each in full, with its reasons: `.archivist/decisions/ADR-NNNN-*.md`.");
    expect(renderCore([decision], cfg({}, "full"))).toContain("сообщения коммитов");
  });

  it("go, in full, to the rule file of their paths when they are scoped, and leave core.md", () => {
    expect(renderCore([scopedDecision], cfg())).not.toContain("Один ключ");
    const area = renderAreas([scopedDecision], cfg()).get(".claude/rules/archivist/src-adapters-claude-mod.md");
    expect(area).toContain("- ADR-0002 **Один ключ хранилища на задачу**: Ключ `archivist:seg:<session>:<segId>` на каждую задачу; общий ключ затирал");
  });
});

describe("the character budget", () => {
  const long = (i: number, type: "command" | "gotcha" | "decision" = "gotcha") =>
    entry({ id: `e-${String(i).padStart(2, "0")}`, type, title: `Fact ${i}`, content: `${"x".repeat(300)} ${i}.`, created: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`, ...(type === "decision" ? { adr: i } : {}) });

  it("keeps core.md within its characters, and says how many entries are left out", () => {
    const core = renderCore(Array.from({ length: 30 }, (_, i) => long(i)), cfg({ coreChars: 3000 }));
    expect(core.length).toBeLessThanOrEqual(3000);
    expect(core).toMatch(/\n\d+ more in `\.archivist\/INDEX\.md`/);
  });

  it("lets in what tasks used, leaves out first what misled, and writes the chosen in a stable order", () => {
    const entries = [long(1), long(2), long(3), long(4)];
    const usage = { "e-04": { seen: 0, used: 5, helpful: 1, harmful: 0 }, "e-01": { seen: 0, used: 0, helpful: 0, harmful: 3 } };
    const core = renderCore(entries, cfg({ coreChars: 1200 }), new Set(), usage);
    expect(core).toContain("Fact 4");
    expect(core).not.toContain("Fact 1**");
    const order = ["Fact 2", "Fact 3", "Fact 4"].map((f) => core.indexOf(f)).filter((i) => i >= 0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("prefers commands, then gotchas, then decisions when nothing tells them apart", () => {
    const core = renderCore([long(1, "decision"), long(2, "gotcha"), long(3, "command")], cfg({ coreChars: 1100 }));
    expect(core).toContain("Fact 3");
    expect(core).toContain("Fact 2");
    expect(core).not.toContain("Fact 1");
  });
});
