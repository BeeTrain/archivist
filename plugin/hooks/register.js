// src/core/io.ts
var PATHS = {
  dir: ".archivist",
  config: ".archivist/config.json",
  ledger: ".archivist/ledger.jsonl",
  index: ".archivist/INDEX.md",
  decisions: ".archivist/decisions",
  // Reports quote the user's prompts and session ids; proposals are one person's queue: both stay local.
  reports: ".archivist/.local/reports",
  proposals: ".archivist/.local/proposals",
  gitignore: ".archivist/.gitignore",
  rulesDir: ".claude/rules/archivist",
  skillsDir: ".claude/skills",
  coreRule: ".claude/rules/archivist/core.md"
};
var joinPath = (...parts) => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
var relPath = (root2, path) => {
  const r = root2.endsWith("/") ? root2 : `${root2}/`;
  return path.startsWith(r) ? path.slice(r.length) : path;
};
var withLocalIgnored = (io) => {
  let checked = false;
  const guard = async () => {
    if (checked) return;
    checked = true;
    const text = await io.read(PATHS.gitignore);
    if (text === void 0) await io.write(PATHS.gitignore, ".local/\n");
    else if (!text.split("\n").some((l) => /^\/?\.local\/?\s*$/.test(l.trim())))
      await io.write(PATHS.gitignore, `${text}${text.endsWith("\n") || !text ? "" : "\n"}.local/
`);
  };
  return {
    ...io,
    async write(path, text) {
      if (path.startsWith(`${PATHS.dir}/`) && path !== PATHS.gitignore) await guard();
      await io.write(path, text);
    }
  };
};

// src/core/config.ts
var DEFAULT_CONFIG = {
  enabled: true,
  language: "auto",
  analyzer: {
    idleSeconds: 90,
    minToolCalls: 5,
    reflect: "fork",
    forkMaxContextTokens: 3e5,
    curateModel: "haiku",
    maxTokensPerDay: 3e6,
    maxRateLimitPercent: 90,
    useCredits: false
  },
  apply: { autoConfidence: 0.8, autoTypes: ["command", "gotcha", "decision"] },
  budgets: { coreLines: 60, coreChars: 6e3, pathFileLines: 40, pathFileChars: 3e3, maxContentChars: 400 },
  rules: { decisions: "compact" },
  privacy: { excludePaths: [".env*", "**/.env*", "**/secrets/**", "**/*.pem", "**/*.key", "**/id_rsa*"] },
  report: { mode: "quiet", toastMs: 15e3 },
  review: { promoteOnRepeat: true, expireDays: 14, expireTasks: 20 }
};
var merge = (base, over) => {
  if (!over) return base;
  const out = { ...base };
  for (const [k2, v] of Object.entries(over)) {
    const b = base[k2];
    out[k2] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" ? merge(b, v) : v;
  }
  return out;
};
var loadConfig = async (io) => {
  const raw = await io.read(PATHS.config);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return merge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
};

// src/core/ledger.ts
var parseLedger = (text) => {
  const records = [];
  const badLines = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line);
      if (r && r.v === 1 && typeof r.op === "string") records.push(r);
      else badLines.push(i + 1);
    } catch {
      badLines.push(i + 1);
    }
  });
  return { records, badLines };
};
var foldLedger = (records) => {
  const entries = /* @__PURE__ */ new Map();
  for (const r of records) {
    if (r.op === "add") {
      entries.set(r.entry.id, { ...r.entry });
      for (const old of r.entry.supersedes ?? []) {
        const e2 = entries.get(old);
        if (e2 && e2.status === "active") entries.set(old, { ...e2, status: "deprecated", deprecatedReason: `superseded by ${r.entry.id}`, updated: r.ts });
      }
      continue;
    }
    const e = entries.get(r.id);
    if (!e) continue;
    if (r.op === "update") entries.set(r.id, { ...e, ...r.patch, updated: r.ts });
    else if (r.op === "deprecate") entries.set(r.id, { ...e, status: "deprecated", deprecatedReason: r.reason, updated: r.ts });
    else if (r.op === "reinforce") entries.set(r.id, { ...e, reinforced: e.reinforced + 1 });
  }
  return entries;
};
var loadState = async (io) => {
  const text = await io.read(PATHS.ledger) ?? "";
  const { records, badLines } = parseLedger(text);
  return { entries: foldLedger(records), badLines };
};
var appendLedger = async (io, records) => {
  if (!records.length) return;
  const prev = await io.read(PATHS.ledger) ?? "";
  const sep = prev && !prev.endsWith("\n") ? "\n" : "";
  await io.write(PATHS.ledger, prev + sep + records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
var PREFIX = { command: "cmd", gotcha: "gk", decision: "dec", procedure: "proc" };
var newId = (type, taken) => {
  for (; ; ) {
    const id = `${PREFIX[type]}-${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
};
var nextAdr = (entries) => {
  let max = 0;
  for (const e of entries) if (e.adr && e.adr > max) max = e.adr;
  return max + 1;
};
var activeEntries = (entries) => [...entries.values()].filter((e) => e.status === "active");

// src/core/text.ts
var normalize = (s) => s.toLowerCase().replace(/[`*_~"'«»“”()[\]{}<>]/g, " ").replace(/[^\p{L}\p{N}./:@+-]+/gu, " ").trim();
var tokens = (s) => normalize(s).split(/\s+/).filter((t) => t.length > 1);
var jaccard = (a, b) => {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};
var slug = (s, max = 48) => normalize(s).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "") || "entry";
var truncate = (s, max) => s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
var searchTokens = (s) => tokens(s).flatMap((t) => t.split(/[-./:@+]+/)).filter((t) => t.length > 1).map((t) => t.slice(0, 5));
var stemSet = (s) => new Set(searchTokens(s));
var stemSimilarity = (a, b) => {
  const A = stemSet(a);
  const B = stemSet(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return { jaccard: inter / (A.size + B.size - inter || 1), overlap: inter / (Math.min(A.size, B.size) || 1) };
};
var coverage = (text, source) => {
  const A = stemSet(text);
  const B = stemSet(source);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size || 1);
};
var NOT_TICKETS = /^(UTF|UCS|ISO|SHA|MD|RFC|HTTP|TLS|SSL|IPV|IEEE|ECMA|ES|X|BASE|AES|RSA|CRC|PEP|JSR|KB|MB|GB)$/;
var ticketRef = (s) => {
  for (const m of s.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,14})-(\d{2,})(?!\d)/g)) if (!NOT_TICKETS.test(m[1])) return `${m[1]}-${m[2]}`;
  return void 0;
};
var firstCode = (s) => s.match(/`([^`]+)`/)?.[1]?.replace(/\s+/g, " ").trim();
var bm25 = (docs, query, k1 = 1.2, b = 0.75) => {
  const docTokens = docs.map(searchTokens);
  const avg = docTokens.reduce((s, d) => s + d.length, 0) / Math.max(docTokens.length, 1);
  const df = /* @__PURE__ */ new Map();
  for (const d of docTokens) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(searchTokens(query))];
  return docTokens.map((d, index) => {
    const tf = /* @__PURE__ */ new Map();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score2 = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score2 += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * d.length / (avg || 1)));
    }
    return { index, score: score2 };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
};
var globToRegExp = (glob) => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};

// src/core/privacy.ts
var MASK = "[redacted]";
var SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi
];
var ASSIGNMENT = /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`]{6,})\3/gi;
var redact = (text) => {
  let count = 0;
  let out = text.replace(ASSIGNMENT, (_m, name, sep, q, value) => {
    if (/^(\$\{?|process\.env|string|number|boolean|undefined|null|<)/.test(value)) return `${name}${sep}${q}${value}${q}`;
    count++;
    return `${name}${sep}${q}${MASK}${q}`;
  });
  for (const re of SECRETS) {
    out = out.replace(re, (m) => {
      count++;
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(m) ? `${m.split("://")[0]}://${MASK}@` : MASK;
    });
  }
  return { text: out, count };
};
var isExcluded = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

// src/core/args.ts
var splitArgs = (s) => {
  const out = [];
  let cur = "";
  let quote;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = void 0;
      else if (c === "\\" && quote === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
};
var parseOptions = (tokens2) => {
  const words = [];
  const opts = {};
  for (let i = 0; i < tokens2.length; i++) {
    const t = tokens2[i];
    if (!t.startsWith("--")) words.push(t);
    else if (i + 1 < tokens2.length && !tokens2[i + 1].startsWith("--")) opts[t.slice(2)] = tokens2[++i];
    else opts[t.slice(2)] = "true";
  }
  return { words, opts };
};
var commaList = (s) => s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];

// src/core/lock.ts
var LOCK = ".archivist/.local/lock";
var STALE_MS = 2 * 6e4;
var WAIT_MS = 3e4;
var POLL_MS = 100;
var withLock = async (io, fn, waitMs = WAIT_MS) => {
  const m = io.mutex;
  if (!m) return fn();
  for (let waited = 0; !await m.claim(LOCK); waited += POLL_MS) {
    const age = await m.age(LOCK);
    if (age !== void 0 && age > STALE_MS) await m.release(LOCK);
    else if (waited >= waitMs)
      throw new Error(`${LOCK} is held by another Archivist writer${age === void 0 ? "" : ` (for ${Math.round(age / 1e3)} s)`}; if none is running, remove that directory`);
    await m.sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await m.release(LOCK);
  }
};

// src/core/types.ts
var ENTRY_TYPES = ["command", "gotcha", "decision", "procedure"];
var emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
var addUsage = (a, b) => ({
  input: a.input + (b.input ?? 0),
  output: a.output + (b.output ?? 0),
  cacheRead: a.cacheRead + (b.cacheRead ?? 0),
  cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0)
});
var weightedTokens = (u) => u.input + u.output + u.cacheWrite + Math.round(u.cacheRead * 0.1);

// src/core/metrics.ts
var METRICS = ".archivist/.local/metrics.jsonl";
var BASELINE = ".archivist/.local/baseline.json";
var ANALYSES = ".archivist/.local/analyses.jsonl";
var appendAnalysis = async (io, r) => {
  const prev = await io.read(ANALYSES) ?? "";
  await io.write(ANALYSES, prev + JSON.stringify(r) + "\n");
};
var loadAnalyses = async (io) => (await io.read(ANALYSES) ?? "").split("\n").flatMap((l) => {
  try {
    return l ? [JSON.parse(l)] : [];
  } catch {
    return [];
  }
});
var toMetrics = (s, ts, source) => ({
  ts,
  source,
  turns: s.turns,
  durationMs: s.durationMs,
  tokens: weightedTokens(s.usage),
  usage: s.usage,
  toolCalls: s.toolCalls,
  edits: s.edits.length,
  readsBeforeFirstEdit: s.readsBeforeFirstEdit,
  repeatedReads: s.repeatedReads.length,
  failedCommands: s.failedCommands.length,
  corrections: s.corrections.length,
  rulesLoaded: s.rulesLoaded.length
});
var appendMetrics = async (io, m) => {
  const prev = await io.read(METRICS) ?? "";
  await io.write(METRICS, prev + JSON.stringify(m) + "\n");
};
var loadMetrics = async (io) => (await io.read(METRICS) ?? "").split("\n").flatMap((l) => {
  try {
    return l ? [JSON.parse(l)] : [];
  } catch {
    return [];
  }
});
var MEASURES = [
  ["tokens", "weighted tokens"],
  ["toolCalls", "tool calls"],
  ["readsBeforeFirstEdit", "reads before first edit"],
  ["repeatedReads", "files re-read"],
  ["failedCommands", "failed commands"],
  ["durationMs", "duration, s"]
];
var median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
var summarize = (ms) => {
  const real = ms.filter((m) => m.toolCalls > 0);
  const medians = Object.fromEntries(MEASURES.map(([k2]) => [k2, median(real.map((m) => m[k2]))]));
  return { tasks: real.length, medians };
};
var loadBaseline = async (io) => {
  try {
    return JSON.parse(await io.read(BASELINE) ?? "");
  } catch {
    return void 0;
  }
};
var fmt = (k2, v) => k2 === "durationMs" ? String(Math.round(v / 1e3)) : k2 === "tokens" ? v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)) : String(Math.round(v * 10) / 10);
var compareText = (baseline, recent) => {
  const lines = [];
  if (!baseline) {
    lines.push("No baseline yet: run `archivist baseline` to measure the sessions before Archivist.", "");
  }
  lines.push(baseline ? `| measure (median per task) | before (${baseline.summary.tasks} tasks) | now (${recent.tasks} tasks) | change |` : `| measure (median per task) | now (${recent.tasks} tasks) |`);
  lines.push(baseline ? "|---|---|---|---|" : "|---|---|");
  for (const [k2, label] of MEASURES) {
    const now = recent.medians[k2];
    if (!baseline) {
      lines.push(`| ${label} | ${fmt(k2, now)} |`);
      continue;
    }
    const before = baseline.summary.medians[k2];
    const change = before && recent.tasks ? `${now <= before ? "\u2212" : "+"}${Math.round(Math.abs(now - before) / before * 100)}%` : "\u2014";
    lines.push(`| ${label} | ${fmt(k2, before)} | ${fmt(k2, now)} | ${change} |`);
  }
  if (!recent.tasks) lines.push("", "No task measured since Archivist started: the comparison comes with the first analysed tasks.");
  else if (baseline && (baseline.summary.tasks < 5 || recent.tasks < 5)) lines.push("", "Fewer than 5 tasks on one side: the change is noise until there are more.");
  return lines.join("\n");
};

// src/core/usage.ts
var USAGE = ".archivist/.local/usage.json";
var loadUsage = async (io) => {
  try {
    return JSON.parse(await io.read(USAGE) ?? "{}");
  } catch {
    return {};
  }
};
var saveUsage = async (io, u) => io.write(USAGE, JSON.stringify(u, null, 1) + "\n");
var bump = (u, id, field, ts) => {
  const e = u[id] ??= { seen: 0, used: 0, helpful: 0, harmful: 0 };
  e[field]++;
  if (ts && field !== "seen") e.lastUsed = ts;
};
var commandWords = (content) => (content.match(/`([^`]+)`/)?.[1] ?? "").split(/\s+/).filter((w) => w && !/^[<[{]/.test(w)).slice(0, 3);
var lastStep = (cmd) => (cmd.split(/&&|;/).at(-1) ?? cmd).trim();
var commandsUsed = (entries, tools) => {
  const ran = tools.filter((t) => t.tool === "Bash" && t.ok && t.target).map((t) => lastStep(t.target));
  return entries.filter((e) => e.type === "command").filter((e) => {
    const words = commandWords(e.content);
    return words.length >= 2 && ran.some((r) => r.startsWith(words.join(" ")));
  }).map((e) => e.id);
};
var recordUse = (u, args) => {
  for (const id of new Set(args.seen)) if (args.known.has(id)) bump(u, id, "seen");
  for (const id of new Set(args.used)) if (args.known.has(id)) bump(u, id, "used", args.ts);
  for (const f of args.feedback) if (args.known.has(f.id)) bump(u, f.id, f.verdict, args.ts);
  return Object.entries(u).filter(([id, e]) => args.known.has(id) && e.harmful >= 2 && e.harmful > e.helpful).map(([id]) => id);
};

// src/core/render.ts
var GENERATED = "<!-- Generated by Archivist from .archivist/ledger.jsonl. Do not edit: changes are overwritten. -->";
var scopeLabel = (e) => e.scope?.paths.length ? ` (${e.scope.paths.join(", ")})` : "";
var adrNo = (e) => `ADR-${String(e.adr ?? 0).padStart(4, "0")}`;
var adrPath = (e) => joinPath(PATHS.decisions, `${adrNo(e)}-${slug(e.title)}.md`);
var byAge = (a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
var oneLine = (s) => s.replace(/\s*\n\s*/g, " ").trim();
var firstSentence = (s) => {
  const t = oneLine(s);
  const f = t.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? t;
  return f.length > 120 ? `${f.slice(0, 119).trimEnd()}\u2026` : f;
};
var lineOf = (e, style) => e.type === "decision" ? `- ${adrNo(e)} **${e.title}**: ${style === "compact" ? firstSentence(e.content) : oneLine(e.content)}` : `- **${e.title}**: ${oneLine(e.content)}`;
var HEADINGS = [
  ["command", "## Commands"],
  ["gotcha", "## Gotchas"],
  ["decision", "## Decisions"]
];
var DECISIONS_NOTE = `Each in full, with its reasons: \`${PATHS.decisions}/ADR-NNNN-*.md\`.`;
var TYPE_RANK = { command: 0, gotcha: 1, decision: 2, procedure: 3 };
var merit = (e, usage) => {
  const u = usage[e.id];
  if (!u) return 0;
  if (u.harmful > u.helpful) return -1 - u.harmful;
  return u.used + u.seen + 2 * u.helpful;
};
var fill = (head2, entries, budget, style, usage) => {
  const ranked = [...entries].sort((a, b) => merit(b, usage) - merit(a, usage) || TYPE_RANK[a.type] - TYPE_RANK[b.type] || byAge(a, b));
  const kept = /* @__PURE__ */ new Set();
  const opened = /* @__PURE__ */ new Set();
  let lines = head2.length + 2;
  let chars = head2.join("\n").length + 80;
  for (const e of ranked) {
    const line = lineOf(e, style);
    const first = !opened.has(e.type);
    const heading = first ? HEADINGS.find(([t]) => t === e.type)?.[1] ?? "" : "";
    const note = first && e.type === "decision" ? DECISIONS_NOTE : "";
    const addLines = 1 + (first ? 2 : 0) + (note ? 1 : 0);
    const addChars = line.length + 1 + (first ? heading.length + 2 : 0) + (note ? note.length + 1 : 0);
    if (lines + addLines > budget.lines || chars + addChars > budget.chars) continue;
    kept.add(e.id);
    opened.add(e.type);
    lines += addLines;
    chars += addChars;
  }
  const out = [...head2];
  for (const [type, heading] of HEADINGS) {
    const items = entries.filter((e) => e.type === type && kept.has(e.id)).sort(byAge);
    if (!items.length) continue;
    out.push("", heading, ...type === "decision" ? [DECISIONS_NOTE] : [], ...items.map((e) => lineOf(e, style)));
  }
  const omitted = entries.length - kept.size;
  if (omitted) out.push("", `${omitted} more in \`${PATHS.index}\` (run \`archivist recall <query>\`).`);
  return { lines: out, omitted };
};
var live = (entries, stale) => entries.filter((e) => e.status === "active" && !stale.has(e.id)).sort(byAge);
var ruleEntries = (entries, stale) => live(entries, stale).filter((e) => e.type !== "procedure");
var isScoped = (e) => Boolean(e.scope?.paths.length);
var renderCore = (entries, config, stale = /* @__PURE__ */ new Set(), usage = {}) => {
  const head2 = [
    GENERATED,
    "# Project knowledge (Archivist)",
    "",
    "Facts learned in earlier sessions. Prefer them over re-discovering; if one is wrong, say so. Before exploring, try `archivist recall <words>`."
  ];
  const core = ruleEntries(entries, stale).filter((e) => !isScoped(e));
  return fill(head2, core, { lines: config.budgets.coreLines, chars: config.budgets.coreChars }, config.rules.decisions, usage).lines.join("\n") + "\n";
};
var groupAreas = (entries, stale = /* @__PURE__ */ new Set()) => {
  const groups = /* @__PURE__ */ new Map();
  for (const e of ruleEntries(entries, stale).filter(isScoped)) {
    const key = [...e.scope.paths].sort().join("\n");
    groups.set(key, [...groups.get(key) ?? [], e]);
  }
  const areas = /* @__PURE__ */ new Map();
  for (const [key, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const paths = key.split("\n");
    const base = slug(paths[0].replace(/[*?{].*$/, "").replace(/\/+$/, "") || "area");
    let name = joinPath(PATHS.rulesDir, `${base}.md`);
    for (let i = 2; areas.has(name) || name === PATHS.coreRule; i++) name = joinPath(PATHS.rulesDir, `${base}-${i}.md`);
    areas.set(name, { paths, items });
  }
  return areas;
};
var renderAreas = (entries, config, stale = /* @__PURE__ */ new Set(), usage = {}) => {
  const files = /* @__PURE__ */ new Map();
  for (const [name, { paths, items }] of groupAreas(entries, stale)) {
    const head2 = ["---", "paths:", ...paths.map((p) => `  - ${JSON.stringify(p)}`), "---", GENERATED, `# Project knowledge for ${paths.join(", ")} (Archivist)`];
    files.set(name, fill(head2, items, { lines: config.budgets.pathFileLines, chars: config.budgets.pathFileChars }, "full", usage).lines.join("\n") + "\n");
  }
  return files;
};
var renderIndex = (entries, stale = /* @__PURE__ */ new Set()) => {
  const active = entries.filter((e) => e.status === "active").sort(byAge);
  const lines = [GENERATED, "# Archivist index", "", "One line per active entry: `id` type (scope): title.", ""];
  for (const e of active) lines.push(`- \`${e.id}\` ${e.type}${scopeLabel(e)}: ${e.title}${stale.has(e.id) ? " \u26A0 stale: its evidence is gone" : ""}`);
  const gone = entries.filter((e) => e.status !== "active").length;
  if (gone) lines.push("", `${gone} deprecated entries are kept in the ledger.`);
  return lines.join("\n") + "\n";
};
var renderAdr = (e) => {
  const status = e.status === "active" ? "Accepted" : `Superseded${e.deprecatedReason ? ` (${e.deprecatedReason})` : ""}`;
  const evidence = e.evidence.filter((v) => v.file).map((v) => `- \`${v.file}\`${v.anchor ? ` (${v.anchor})` : ""}`);
  return [
    GENERATED,
    `# ADR-${String(e.adr ?? 0).padStart(4, "0")}: ${e.title}`,
    "",
    `- Status: ${status}`,
    `- Date: ${e.created.slice(0, 10)}`,
    `- Entry: \`${e.id}\``,
    "",
    "## Context",
    "",
    e.rationale ?? "_Not recorded._",
    "",
    "## Decision",
    "",
    e.content,
    ...evidence.length ? ["", "## Evidence", "", ...evidence] : [],
    ""
  ].join("\n");
};
var skillPath = (e) => {
  const ascii = slug(e.title, 40).replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return joinPath(PATHS.skillsDir, `archivist-${ascii.length >= 3 ? ascii : e.id}`, "SKILL.md");
};
var renderSkill = (e) => {
  const name = skillPath(e).split("/").at(-2);
  const description = oneLine(`${e.title.replace(/[.\s]+$/, "")}.${e.rationale ? ` ${e.rationale}` : ""}`);
  return ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "---", GENERATED, `# ${e.title}`, "", e.content.trim(), ""].join("\n");
};
var renderViews = (entries, config, stale = /* @__PURE__ */ new Set(), usage = {}) => {
  const all = [...entries.values()];
  const views = /* @__PURE__ */ new Map();
  views.set(PATHS.coreRule, renderCore(all, config, stale, usage));
  for (const [path, text] of renderAreas(all, config, stale, usage)) views.set(path, text);
  views.set(PATHS.index, renderIndex(all, stale));
  for (const e of all) if (e.type === "decision" && e.adr) views.set(adrPath(e), renderAdr(e));
  for (const e of live(all, stale)) if (e.type === "procedure") views.set(skillPath(e), renderSkill(e));
  return views;
};
var findStale = async (io, entries) => {
  const stale = /* @__PURE__ */ new Set();
  for (const e of entries.values()) {
    if (e.status !== "active") continue;
    const files = e.evidence.map((v) => v.file).filter((f) => Boolean(f));
    if (!files.length) continue;
    let any = false;
    for (const f of files) if (await io.exists(f)) any = true;
    if (!any) stale.add(e.id);
  }
  return stale;
};
var writeViews = async (io, views) => {
  const written = [];
  for (const [path, text] of views) {
    if (await io.read(path) === text) continue;
    await io.write(path, text);
    written.push(path);
  }
  return written;
};
var pruneViews = async (io, views) => {
  if (!io.remove) return [];
  const files = [];
  for (const dir of [PATHS.rulesDir, PATHS.decisions])
    for (const name of await io.list(dir)) if (name.endsWith(".md")) files.push(joinPath(dir, name));
  const skillDirs = (await io.list(PATHS.skillsDir)).filter((d) => d.startsWith("archivist-")).map((d) => joinPath(PATHS.skillsDir, d));
  for (const dir of skillDirs) files.push(joinPath(dir, "SKILL.md"));
  const removed = [];
  for (const path of files) {
    if (views.has(path) || !await io.exists(path)) continue;
    if (!(await io.read(path) ?? "").slice(0, 600).includes(GENERATED)) continue;
    await io.remove(path);
    removed.push(path);
  }
  for (const dir of skillDirs) {
    if (views.has(joinPath(dir, "SKILL.md")) || await io.exists(joinPath(dir, "SKILL.md"))) continue;
    if (!io.removeEmptyDir || (await io.list(dir)).length) continue;
    await io.removeEmptyDir(dir);
    removed.push(`${dir}/`);
  }
  return removed;
};
var renderAll = async (io, entries, config) => {
  const stale = await findStale(io, entries);
  const views = renderViews(entries, config, stale, await loadUsage(io));
  return { written: await writeViews(io, views), removed: await pruneViews(io, views), stale };
};

// src/core/validate.ts
var PROCEDURE_CHARS = 1500;
var DUP_ENTRY = 0.6;
var PARAPHRASE = { jaccard: 0.35, overlap: 0.55 };
var DUP_DOC = 0.6;
var DOC_COVERAGE = 0.6;
var family = (t) => t === "command" || t === "gotcha" ? "fact" : t;
var findDuplicate = (entries, type, title, content) => {
  const text = `${title} ${content}`;
  let best;
  for (const e of entries) {
    if (e.status !== "active" || family(e.type) !== family(type)) continue;
    const other = `${e.title} ${e.content}`;
    if (e.type === type && jaccard(other, text) >= DUP_ENTRY) return e;
    if (e.type === "command" && type === "command" && firstCode(e.content) && firstCode(content) && firstCode(e.content) !== firstCode(content)) continue;
    const s = stemSimilarity(other, text);
    if (s.jaccard >= PARAPHRASE.jaccard && s.overlap >= PARAPHRASE.overlap && (!best || s.jaccard > best.score)) best = { e, score: s.jaccard };
  }
  return best?.e;
};
var sameFact = (a, b) => {
  if (jaccard(a, b) >= DUP_ENTRY) return true;
  const s = stemSimilarity(a, b);
  return s.jaccard >= PARAPHRASE.jaccard && s.overlap >= PARAPHRASE.overlap;
};
var docWindows = (docs) => {
  const lines = docs.flatMap((d) => d.split("\n")).map((l) => l.trim()).filter((l) => l.length > 20);
  return lines.map((_, i) => lines.slice(i, i + 3).join(" "));
};
var clamp01 = (n) => typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
var docParagraphs = (docs) => docs.flatMap((d) => d.split(/\n\s*\n|\n(?=[-*] )/)).map((p) => p.trim()).filter((p) => p.length > 20);
var validateOps = async (args) => {
  const { ops, entries, io, config, now, src } = args;
  const out = { records: [], applied: [], proposals: [], rejected: [], firstSightings: [], promoted: [] };
  const paragraphs = docParagraphs(args.docs);
  const windows = docWindows(args.docs);
  const taken = new Set(entries.keys());
  let adr = nextAdr(entries.values());
  const touched = /* @__PURE__ */ new Set();
  const active = (id) => {
    const e = entries.get(id);
    return e && e.status === "active" ? e : void 0;
  };
  const route = (confidence, type) => confidence >= config.apply.autoConfidence && config.apply.autoTypes.includes(type) ? "apply" : "propose";
  for (const raw of ops) {
    const op = raw;
    if (!op || typeof op !== "object" || !("op" in op)) {
      out.rejected.push({ op, reason: "not an op" });
      continue;
    }
    if (op.op === "add") {
      if (!ENTRY_TYPES.includes(op.type)) {
        out.rejected.push({ op, reason: `unknown type ${String(op.type)}` });
        continue;
      }
      const t = redact(truncate(String(op.title ?? "").trim(), 120));
      const c = redact(truncate(String(op.content ?? "").trim(), op.type === "procedure" ? PROCEDURE_CHARS : config.budgets.maxContentChars));
      const r = op.rationale ? redact(truncate(String(op.rationale).trim(), config.budgets.maxContentChars)) : void 0;
      const title = t.text;
      const content = c.text;
      if (!title || !content) {
        out.rejected.push({ op, reason: "empty title or content" });
        continue;
      }
      let confidence = clamp01(op.confidence);
      const notes = [];
      if (t.count + c.count + (r?.count ?? 0)) {
        confidence = Math.min(confidence, config.apply.autoConfidence - 0.01);
        notes.push("secrets redacted");
      }
      const ticket = ticketRef(`${title} ${content} ${r?.text ?? ""}`);
      if (ticket) {
        confidence = Math.min(confidence, config.apply.autoConfidence - 0.01);
        notes.push(`tied to ticket ${ticket}`);
      }
      if ((args.skipped ?? []).some((s) => jaccard(s, `${title} ${content}`) >= DUP_ENTRY)) {
        out.rejected.push({ op, reason: "skipped in an earlier review" });
        continue;
      }
      if (op.type === "procedure" && args.source !== "user") {
        if (!(args.procedureCandidates ?? []).some((s) => jaccard(s, `${title} ${content}`) >= 0.4)) {
          out.firstSightings.push(`${title} ${content}`);
          out.rejected.push({ op, reason: "procedure seen once: waiting for a repeat" });
          continue;
        }
        confidence = Math.min(confidence, config.apply.autoConfidence - 0.01);
        notes.push("seen in an earlier task too");
      }
      const dup = findDuplicate(entries.values(), op.type, title, content);
      if (dup) {
        if (!touched.has(dup.id)) {
          touched.add(dup.id);
          out.records.push({ v: 1, ts: now, op: "reinforce", id: dup.id, src });
          out.applied.push({ op: { op: "reinforce", id: dup.id }, id: dup.id, type: dup.type, title: dup.title, reason: "duplicate of existing entry" });
        }
        continue;
      }
      const fact = `${title} ${content}`;
      const tiny = new Set(fact.match(/\S+/g) ?? []).size < 4;
      const codes = op.type === "command" ? [...content.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, " ").trim()).filter((c2) => c2.length >= 3) : [];
      const codeInDocs = codes.some((c2) => c2.includes(" ")) && codes.every((c2) => args.docs.some((d) => d.includes(c2)));
      if (codeInDocs || paragraphs.some((p) => jaccard(p, fact) >= DUP_DOC) || !tiny && windows.some((w) => coverage(fact, w) >= DOC_COVERAGE)) {
        out.rejected.push({ op, reason: "already in project docs" });
        continue;
      }
      const evidence = [];
      for (const ev of op.evidence ?? []) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.file && isExcluded(ev.file, config.privacy.excludePaths)) continue;
        if (ev.file && !await io.exists(ev.file)) {
          notes.push(`evidence file not found: ${ev.file}`);
          continue;
        }
        evidence.push({ ...ev.file ? { file: ev.file } : {}, ...ev.anchor ? { anchor: String(ev.anchor) } : {} });
      }
      if ((op.evidence?.some((e) => e?.file) ?? false) && !evidence.some((e) => e.file)) confidence -= 0.3;
      if (op.type === "decision" && !op.rationale) {
        confidence = Math.min(confidence, config.apply.autoConfidence - 0.01);
        notes.push("decision without rationale");
      }
      const supersedes = (op.supersedes ?? []).filter((id2) => active(id2));
      const id = newId(op.type, taken);
      taken.add(id);
      const entry = {
        id,
        type: op.type,
        title,
        content,
        ...r ? { rationale: r.text } : {},
        ...op.scope?.paths?.length ? { scope: { paths: op.scope.paths.map(String) } } : {},
        evidence,
        status: "active",
        confidence: clamp01(confidence),
        source: args.source ?? "analyzer",
        created: now,
        updated: now,
        ...op.type === "decision" ? { adr } : {},
        ...supersedes.length ? { supersedes } : {},
        ...op.savings && (op.savings.toolCalls || op.savings.tokens) ? { savings: { toolCalls: Number(op.savings.toolCalls) || 0, tokens: Number(op.savings.tokens) || 0 } } : {},
        reinforced: 0
      };
      const earlier = route(entry.confidence, op.type) === "propose" && config.review.promoteOnRepeat && family(op.type) === "fact" && !notes.includes("secrets redacted") && !ticket ? (args.pending ?? []).find((p) => p.op.op === "add" && family(p.op.type) === "fact" && !out.promoted.includes(p.id) && sameFact(`${p.op.title} ${p.op.content}`, `${title} ${content}`)) : void 0;
      if (earlier) {
        entry.confidence = Math.max(entry.confidence, config.apply.autoConfidence);
        notes.push("proposed again in a later task");
        out.promoted.push(earlier.id);
      }
      const o = { op, id, type: op.type, title, ...notes.length ? { reason: notes.join("; ") } : {} };
      if (earlier || route(entry.confidence, op.type) === "apply") {
        if (op.type === "decision") adr++;
        out.records.push({ v: 1, ts: now, op: "add", entry, src });
        out.applied.push(o);
      } else {
        delete entry.adr;
        out.proposals.push({ ...o, op: { ...op, title, content } });
      }
      continue;
    }
    const target = "id" in op ? active(op.id) : void 0;
    if (!target) {
      out.rejected.push({ op, reason: `no active entry ${"id" in op ? op.id : "?"}` });
      continue;
    }
    if (touched.has(target.id)) continue;
    touched.add(target.id);
    const base = { op, id: target.id, type: target.type, title: target.title };
    if (op.op === "reinforce") {
      out.records.push({ v: 1, ts: now, op: "reinforce", id: target.id, src });
      out.applied.push(base);
    } else if (op.op === "update") {
      const clean = (s, max) => redact(truncate(s.trim(), max)).text;
      const patch = {
        ...op.title ? { title: clean(op.title, 120) } : {},
        ...op.content ? { content: clean(op.content, config.budgets.maxContentChars) } : {},
        ...op.rationale ? { rationale: clean(op.rationale, config.budgets.maxContentChars) } : {}
      };
      if (!Object.keys(patch).length) {
        out.rejected.push({ ...base, reason: "empty update" });
      } else if (route(clamp01(op.confidence), target.type) === "apply") {
        out.records.push({ v: 1, ts: now, op: "update", id: target.id, patch, src });
        out.applied.push(base);
      } else out.proposals.push(base);
    } else if (op.op === "deprecate") {
      if (clamp01(op.confidence) >= Math.max(0.9, config.apply.autoConfidence) && config.apply.autoTypes.includes(target.type)) {
        out.records.push({ v: 1, ts: now, op: "deprecate", id: target.id, reason: String(op.reason ?? ""), src });
        out.applied.push({ ...base, reason: op.reason });
      } else out.proposals.push({ ...base, reason: op.reason });
    }
  }
  return out;
};

// src/core/review.ts
var SKIPPED = ".archivist/.local/skipped.jsonl";
var listProposals = async (io) => {
  const names = (await io.list(PATHS.proposals)).filter((n) => n.endsWith(".json")).sort();
  const out = [];
  for (const name of names) {
    const path = joinPath(PATHS.proposals, name);
    try {
      const p = JSON.parse(await io.read(path) ?? "");
      out.push({ n: out.length + 1, id: name.replace(/\.json$/, ""), ts: p.ts ?? "", path, op: p.op, reason: p.reason ?? null, ...p.src ? { src: p.src } : {} });
    } catch {
    }
  }
  return out;
};
var describeOp = (op) => {
  if (op.op === "add") return `+ [${op.type}] ${op.title}: ${op.content}${op.rationale ? ` (why: ${op.rationale})` : ""}`;
  if (op.op === "update") return `~ ${op.id}: ${op.content ?? op.title ?? ""}`;
  if (op.op === "deprecate") return `\u2212 ${op.id}: ${op.reason}`;
  return `\u2191 ${op.id}`;
};
var reviewText = (proposals) => proposals.length ? [
  `${proposals.length} proposal(s) waiting for review:`,
  ...proposals.map((p) => `${p.n}. ${describeOp(p.op)}${p.reason ? `  \u2014 ${p.reason}` : ""}`),
  "",
  "apply <n|all> records a proposal as is; skip <n|all> drops it and keeps the idea from coming back.",
  "Or let the agent do it: /archivist:triage checks the technical ones in the code and asks you only about decisions and removals.",
  "Unreviewed proposals expire on their own; a fact that matters comes up again and a repeat records it.",
  `To edit before applying, change the op in its file under ${PATHS.proposals}/ and apply it.`
].join("\n") : "No proposals waiting for review.";
var pick = (proposals, which) => {
  if (which.trim() === "all") return proposals;
  const keys = new Set(which.split(/[\s,]+/).filter(Boolean));
  return proposals.filter((p) => keys.has(String(p.n)) || keys.has(p.id));
};
var needsHuman = (op) => op.op === "deprecate" || op.op === "add" && op.type === "decision";
var asUser = (config) => ({ ...config, apply: { autoConfidence: 0, autoTypes: [...ENTRY_TYPES] } });
var record = async (io, config, ops, now, src) => {
  const state = await loadState(io);
  const v = await validateOps({ ops, entries: state.entries, io, config: asUser(config), docs: [], now, source: "user", ...src ? { src } : {} });
  await appendLedger(io, v.records);
  await renderAll(io, (await loadState(io)).entries, config);
  return [...v.applied, ...v.rejected];
};
var stillWaiting = async (io, chosen) => {
  const out = [];
  for (const p of chosen) if (await io.exists(p.path)) out.push(p);
  return out;
};
var applyProposals = async (io, config, chosen, now) => withLock(io, async () => {
  const outcomes = [];
  for (const p of await stillWaiting(io, chosen)) {
    outcomes.push(...await record(io, config, [{ ...p.op, confidence: 1 }], now, p.src));
    await io.remove?.(p.path);
  }
  return outcomes;
});
var skipProposals = async (io, chosen, now) => withLock(io, async () => {
  const waiting = await stillWaiting(io, chosen);
  const prev = await io.read(SKIPPED) ?? "";
  const lines = waiting.map((p) => JSON.stringify({ ts: now, text: p.op.op === "add" ? `${p.op.title} ${p.op.content}` : describeOp(p.op) }));
  if (lines.length) await io.write(SKIPPED, prev + lines.join("\n") + "\n");
  for (const p of waiting) await io.remove?.(p.path);
  return waiting.length;
});
var loadSkipped = async (io) => (await io.read(SKIPPED) ?? "").split("\n").filter(Boolean).flatMap((l) => {
  try {
    return [String(JSON.parse(l).text)];
  } catch {
    return [];
  }
});
var editFromOptions = (o) => ({
  ...o.title ? { title: o.title } : {},
  ...o.content ? { content: o.content } : {},
  ...o.why ? { rationale: o.why } : {},
  ..."paths" in o ? { paths: commaList(o.paths === "true" ? "" : o.paths) } : {}
});
var activeEntry = async (io, id) => {
  const e = (await loadState(io)).entries.get(id);
  return e && e.status === "active" ? e : void 0;
};
var editEntry = async (io, config, id, edit, now) => withLock(io, async () => {
  const e = await activeEntry(io, id);
  if (!e) return { ok: false, reason: `no active entry ${id}` };
  const max = e.type === "procedure" ? 1500 : config.budgets.maxContentChars;
  const clean = (s, n) => redact(truncate(s.trim(), n)).text;
  const patch = {};
  if (edit.title?.trim() && edit.title.trim() !== e.title) patch.title = clean(edit.title, 120);
  if (edit.content?.trim() && edit.content.trim() !== e.content) patch.content = clean(edit.content, max);
  if (edit.rationale?.trim() && edit.rationale.trim() !== e.rationale) patch.rationale = clean(edit.rationale, max);
  if (edit.paths && edit.paths.join("\n") !== (e.scope?.paths ?? []).join("\n")) patch.scope = { paths: edit.paths };
  if (!Object.keys(patch).length) return { ok: false, reason: "nothing to change" };
  await appendLedger(io, [{ v: 1, ts: now, op: "update", id, patch }]);
  const after = await loadState(io);
  const r = await renderAll(io, after.entries, config);
  return { ok: true, entry: after.entries.get(id), written: r.written, removed: r.removed };
});
var deprecateEntry = async (io, config, id, reason, now) => withLock(io, async () => {
  const e = await activeEntry(io, id);
  if (!e) return { ok: false, reason: `no active entry ${id}` };
  if (!reason.trim()) return { ok: false, reason: "say why: --reason" };
  await appendLedger(io, [{ v: 1, ts: now, op: "deprecate", id, reason: redact(reason.trim()).text }]);
  const after = await loadState(io);
  const r = await renderAll(io, after.entries, config);
  return { ok: true, entry: after.entries.get(id), written: r.written, removed: r.removed };
});
var expireProposals = async (io, config, now) => {
  const tasks = (await loadMetrics(io)).filter((m) => m.source === "live").map((m) => m.ts);
  const gone = [];
  for (const p of await listProposals(io)) {
    if (!p.ts) continue;
    const days = (now.getTime() - Date.parse(p.ts)) / 864e5;
    const later = tasks.filter((t) => t > p.ts).length;
    if (days < config.review.expireDays && later < config.review.expireTasks) continue;
    await io.remove?.(p.path);
    gone.push(p);
  }
  return gone;
};

// src/core/maintenance.ts
var RECENT = 30;
var statsText = async (io, entries) => {
  const live2 = (await loadMetrics(io)).filter((m) => m.source === "live").slice(-RECENT);
  const baseline = await loadBaseline(io);
  const recent = summarize(live2);
  const usage = await loadUsage(io);
  const active = activeEntries(entries);
  const lines = ["# Archivist stats", "", compareText(baseline, recent), ""];
  const promised = active.filter((e) => e.savings && (usage[e.id]?.used ?? 0) > 0);
  if (promised.length) {
    const calls = promised.reduce((s, e) => s + (e.savings.toolCalls ?? 0) * usage[e.id].used, 0);
    const observed = baseline ? Math.round((baseline.summary.medians.toolCalls - recent.medians.toolCalls) * recent.tasks) : void 0;
    lines.push(
      `Estimated by the analyzer for the entries tasks used: \u2248 ${calls} tool calls saved.` + (observed !== void 0 ? ` Observed against the baseline: \u2248 ${observed} over ${recent.tasks} tasks.` : ""),
      ""
    );
  }
  const row = (e) => {
    const u = usage[e.id];
    return `| \`${e.id}\` ${e.title} | ${u?.seen ?? 0} | ${u?.used ?? 0} | ${u?.helpful ?? 0} | ${u?.harmful ?? 0} |`;
  };
  const touched = active.filter((e) => usage[e.id]).sort((a, b) => score(usage, b) - score(usage, a));
  lines.push(`${active.length} active entries; ${touched.length} met in a task, ${active.length - touched.length} never yet.`);
  if (touched.length) lines.push("", "| entry | seen | used | helpful | harmful |", "|---|---|---|---|---|", ...touched.slice(0, 15).map(row));
  const flagged = active.filter((e) => (usage[e.id]?.harmful ?? 0) > (usage[e.id]?.helpful ?? 0));
  if (flagged.length) lines.push("", `Judged wrong more often than helpful: ${flagged.map((e) => `\`${e.id}\``).join(", ")}. See /archivist review.`);
  return lines.join("\n") + "\n";
};
var score = (u, e) => (u[e.id]?.used ?? 0) + (u[e.id]?.helpful ?? 0) * 2 - (u[e.id]?.harmful ?? 0) * 2;
var recallText = (entries, query, k2 = 5) => {
  const active = activeEntries(entries);
  const hits = bm25(active.map((e) => `${e.title} ${e.content} ${e.rationale ?? ""} ${e.scope?.paths.join(" ") ?? ""}`), query).slice(0, k2);
  if (!hits.length) return `Nothing recorded about "${query}".`;
  return hits.map(({ index }) => {
    const e = active[index];
    const where = e.type === "decision" ? ` \u2192 ${adrPath(e)}` : e.scope ? ` (${e.scope.paths.join(", ")})` : "";
    return `- \`${e.id}\` [${e.type}] ${e.title}: ${e.content.replace(/\s*\n\s*/g, " ")}${where}`;
  }).join("\n");
};
var lint = async (io, entries, config) => {
  const out = [];
  const active = activeEntries(entries);
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.type !== b.type) continue;
      const sim = jaccard(`${a.title} ${a.content}`, `${b.title} ${b.content}`);
      if (sim >= 0.45) out.push({ level: "warn", text: `\`${a.id}\` and \`${b.id}\` say much the same (${Math.round(sim * 100)}%): merge, or one contradicts the other` });
      else if (a.type === "command" && a.title.toLowerCase() === b.title.toLowerCase())
        out.push({ level: "warn", text: `\`${a.id}\` and \`${b.id}\` are both "${a.title}" with different commands: which one is right?` });
    }
  for (const id of await findStale(io, entries)) out.push({ level: "warn", text: `\`${id}\` is stale: every file it cites is gone` });
  const usage = await loadUsage(io);
  for (const e of active) {
    if (e.type === "decision" && !e.rationale) out.push({ level: "warn", text: `\`${e.id}\` is a decision without a reason` });
    if ((usage[e.id]?.harmful ?? 0) > (usage[e.id]?.helpful ?? 0)) out.push({ level: "warn", text: `\`${e.id}\` was judged wrong more often than helpful` });
    if (!e.evidence.some((v) => v.file) && e.type !== "decision") out.push({ level: "info", text: `\`${e.id}\` cites no file: it cannot go stale when the code changes` });
  }
  const core = renderCore([...entries.values()], config);
  const omitted = core.match(/(\d+) more in `/);
  if (omitted) out.push({ level: "warn", text: `${omitted[1]} entries do not fit in ${PATHS.coreRule} (${config.budgets.coreLines} lines): scope some to paths, or retire some` });
  return out;
};
var WEEK = 7 * 864e5;
var healthText = async (io, entries, config, now, extras = {}) => {
  const since = new Date(now.getTime() - WEEK).toISOString();
  const active = activeEntries(entries);
  const by = (t) => active.filter((e) => e.type === t).length;
  const stale = await findStale(io, entries);
  const queue = await listProposals(io);
  const human = queue.filter((p) => needsHuman(p.op)).length;
  const coreText = await io.read(PATHS.coreRule) ?? "";
  const coreLines = Math.max(0, coreText.split("\n").length - 1);
  const coreChars = coreText.length;
  const areas = groupAreas(active, stale).size;
  const week = (await loadAnalyses(io)).filter((a) => a.ts >= since);
  const done = week.filter((a) => a.outcome === "done");
  const tasks = (await loadMetrics(io)).filter((m) => m.source === "live" && m.ts >= since).length;
  const errors = week.filter((a) => a.error).length;
  const logWeek = (extras.log ?? []).filter((l) => l.slice(0, 24) >= since);
  const failed = logWeek.filter((l) => l.includes(": failed:")).length;
  const postponed = logWeek.filter((l) => l.includes(": postponed:")).length;
  const recorded = done.reduce((s, a) => s + a.applied, 0);
  const proposed = done.reduce((s, a) => s + a.proposals, 0);
  const spent = week.reduce((s, a) => s + a.tokens, 0);
  const usage = await loadUsage(io);
  const met = active.filter((e) => usage[e.id]).length;
  const neverMet = active.filter((e) => e.type !== "decision" && !stale.has(e.id) && !usage[e.id] && e.created < since);
  const wrong = active.filter((e) => (usage[e.id]?.harmful ?? 0) > (usage[e.id]?.helpful ?? 0));
  const warnings = (await lint(io, entries, config)).filter((f) => f.level === "warn");
  const k2 = (n) => n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
  const lines = [
    "# Archivist health",
    "",
    "## Knowledge",
    `- ${active.length} active entries: ${by("command")} commands, ${by("gotcha")} gotchas, ${by("decision")} decisions, ${by("procedure")} procedures; ${entries.size - active.length} retired; ${stale.size} stale`,
    `- always loaded: ${PATHS.coreRule} ${coreLines}/${config.budgets.coreLines} lines, ${coreChars}/${config.budgets.coreChars} chars (\u2248 ${Math.round(coreChars / 3)} tokens every session); ${areas} path-scoped rule files`,
    `- review queue: ${queue.length}${human ? ` (${human} decisions or removals wait for you)` : ""}`,
    "",
    "## Last 7 days",
    week.length || !tasks ? `- ${tasks} tasks seen; ${week.length} analysed: ${done.length} fully, ${week.length - done.length} skipped as trivial` : `- ${tasks} tasks seen; the analysis journal starts with Archivist 1.3.0, so these counts fill in from the next analysed task`,
    `- recorded ${recorded} entries, proposed ${proposed}; analysis cost ${k2(spent)} weighted tokens${extras.spentToday !== void 0 ? ` (today ${k2(extras.spentToday)} of ${k2(config.analyzer.maxTokensPerDay)})` : ""}`,
    `- problems: ${errors} analyses with model errors${extras.log ? `, ${failed} failed, ${postponed} postponed` : ""}`,
    "",
    "## Entries in use",
    `- ${met} of ${active.length} met in a task (rule loaded, command run, or confirmed)`,
    ...neverMet.length ? [`- never met, older than a week: ${neverMet.slice(0, 5).map((e) => `\`${e.id}\` ${e.title}`).join("; ")}${neverMet.length > 5 ? ` and ${neverMet.length - 5} more` : ""}`] : [],
    ...wrong.length ? [`- judged wrong more often than helpful: ${wrong.map((e) => `\`${e.id}\``).join(", ")}`] : []
  ];
  if (warnings.length) lines.push("", "## Lint", ...warnings.slice(0, 10).map((w) => `- ${w.text}`), ...warnings.length > 10 ? [`- and ${warnings.length - 10} more: archivist lint`] : []);
  const todo = [];
  if (human || queue.length >= 5) todo.push(`/archivist:triage: ${queue.length} proposals${human ? `, ${human} of them need your yes or no` : ""}`);
  if (failed || errors) todo.push("/archivist log: some analyses failed; send the log if it keeps happening");
  if (stale.size) todo.push(`${stale.size} stale entries: /archivist edit or /archivist deprecate (see ${PATHS.index})`);
  if (neverMet.length >= 3) todo.push(`${neverMet.length} entries never met in a week: archivist gc --days 7 lists them, --apply retires them`);
  if (warnings.some((w) => !w.text.includes("stale") && !w.text.includes("judged wrong"))) todo.push("lint findings above: merge or fix them with /archivist edit or /archivist deprecate");
  if (coreLines > config.budgets.coreLines * 0.9 || coreChars > config.budgets.coreChars * 0.9) todo.push(`${PATHS.coreRule} is near its budget: scope entries to paths (/archivist edit <id> --paths "\u2026")`);
  if (week.length >= 5 && !done.some((a) => a.applied || a.proposals)) todo.push("nothing recorded in a week of tasks: the thresholds may be too strict (analyzer.minToolCalls, apply.autoConfidence)");
  if (!await loadBaseline(io)) todo.push("no baseline yet: archivist baseline, so /archivist stats can show the effect");
  lines.push("", "## What to do", ...todo.length ? todo.map((t) => `- ${t}`) : ["- Nothing: Archivist is doing fine here."]);
  return lines.join("\n") + "\n";
};

// src/core/log.ts
var LOG_LINES = 100;
var logKey = (root2) => `archivist:log:${root2}`;
var withLine = (lines, line, at, max = LOG_LINES) => [...lines ?? [], `${at.toISOString()} ${line}`].slice(-max);

// src/core/status.ts
var shouldRecount = (kind) => kind !== "event";
var countsText = (entries, queued) => entries || queued ? `\u{1F4DA} ${entries} entries${queued ? ` \xB7 ${queued} to review` : ""}` : void 0;

// src/analyzer/digest.ts
var toolLine = (t) => {
  const i = t.input;
  const target = String(i.file_path ?? i.command ?? i.pattern ?? i.path ?? i.description ?? "");
  const err = t.isError ? ` \u2717 ${truncate((t.text ?? "").replace(/\s+/g, " "), 200)}` : "";
  return `  \xB7 ${t.tool}(${truncate(target.replace(/\s+/g, " "), 160)})${err}`;
};
var digestFromMessages = (messages, maxChars = 4e4) => {
  const out = [];
  for (const m of messages) {
    if (m.role === "user" && m.text.trim()) out.push(`USER: ${truncate(m.text.trim(), 1500)}`);
    if (m.role === "assistant") {
      if (m.text.trim()) out.push(`AGENT: ${truncate(m.text.trim(), 800)}`);
      for (const t of m.toolUses ?? []) out.push(toolLine(t));
    }
  }
  let text = out.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars * 0.4)}
\u2026
${text.slice(-maxChars * 0.6)}`;
  return text;
};
var digestFromSegment = (seg2) => {
  const out = [];
  seg2.prompts.forEach((p, i) => {
    out.push(`USER: ${truncate(p.trim(), 1500)}`);
    const a = seg2.answers[i];
    if (a) out.push(`AGENT: ${truncate(a.trim(), 1200)}`);
  });
  for (const t of seg2.tools) out.push(`  \xB7 ${t.tool}(${truncate(t.target ?? "", 160)})${t.ok ? "" : ` \u2717 ${t.error ?? ""}`}`);
  return out.join("\n");
};
var sliceTask = (messages, firstPrompt, fallback = 200) => {
  if (firstPrompt) {
    const key = firstPrompt.trim().slice(0, 120);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && m.text.trim().startsWith(key)) return messages.slice(i);
    }
  }
  return messages.slice(-fallback);
};

// src/analyzer/parse.ts
var extractJson = (text) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced?.[1] ?? text;
  const start = src.indexOf("{");
  if (start < 0) return void 0;
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
        return void 0;
      }
    }
  }
  return void 0;
};
var parseCuratorReply = (text) => {
  const json = extractJson(text);
  if (!json || typeof json !== "object") return void 0;
  const ops = Array.isArray(json.ops) ? json.ops.filter((o) => o && typeof o === "object" && typeof o.op === "string") : [];
  const feedback = Array.isArray(json.feedback) ? json.feedback.filter((f) => f && typeof f.id === "string" && (f.verdict === "helpful" || f.verdict === "harmful")).map((f) => ({ id: f.id, verdict: f.verdict })) : [];
  return { summary: typeof json.summary === "string" ? json.summary : "", ops, feedback };
};

// src/analyzer/prompts.ts
var languageRule = (language, auto) => language === "auto" ? auto : `write in ${language}`;
var reflectPrompt = (firstPrompt, language = "auto", entries = []) => [
  "[Archivist plugin \u2014 a side question, not a task. Do not continue the work and do not call tools.]",
  "",
  firstPrompt ? `Look ONLY at the most recent task: the messages from the user's request \xAB${truncate(firstPrompt.trim(), 300)}\xBB to now. Earlier work in this session is not part of it: leave it out even if it was instructive.` : "Look ONLY at the most recent task in this session; leave earlier work out.",
  "List only what would save time, tokens or context in FUTURE tasks in this project and that cannot be quickly derived from the code itself:",
  "",
  "COMMANDS: exact commands (build, test, lint, run, generate) that turned out to be right, especially after wrong attempts.",
  "GOTCHAS: pitfalls and non-obvious constraints you hit: where (file or path) and how to avoid them.",
  "DECISIONS: decisions made in this task: what was chosen, why, which alternatives were rejected; with files.",
  "WASTE: where steps or tokens were wasted, and which single note would have prevented it.",
  "PROCEDURE: if the task followed a multi-step workflow likely to recur (release, migration, adding an endpoint), its steps in order; else \xAB\u2014\xBB.",
  ...entries.length ? [
    "ENTRIES: these notes from earlier sessions were available. Name the ids you actually relied on (USED) and any that were wrong or misled you (WRONG), with one reason each:",
    ...entries.map((e) => `  ${e.id}: ${e.title}`)
  ] : [],
  "",
  "Rules: short bullets; give a file path as evidence when there is one; invent nothing; write \xAB\u2014\xBB for an empty section;",
  `no secrets, tokens or personal data; no overview of the codebase; at most 25 lines; ${languageRule(language, "write in the language of the user's request")}.`
].join("\n");
var CURATE_SYSTEM = [
  "You curate a small knowledge base that an AI coding agent reads at the start of every session in one project.",
  "Every line it reads costs tokens in every future session, and agents follow everything written, so be strict:",
  "- Keep only facts the agent cannot derive quickly from the code: exact commands, non-obvious pitfalls, decisions with their reasons.",
  "- Never write overviews, directory structure, generic best practices, or anything already in the existing project docs.",
  "- Never record one-off operations the task already finished (creating a repo, setting up credentials, rewriting a commit): only what a future task will need again.",
  '- Never record temporary state or to-dos ("revert X after the test", "not run yet", "until phase 4"): only facts that stay true.',
  '- Never tie an entry to the task at hand: no ticket numbers (ABC-123), no branch names of the current work, no epic. State the rule that outlives the task without them ("each batch gets its own branch, merged locally", not "branch tech/ABC-123-\u2026"), or leave it out.',
  "- Only knowledge of THIS project: never the user's machine or accounts (dotfiles, global git config, shell setup, credentials), never other repositories, never what tools already enforce without the agent (git config, hooks, linters, CI). The test: would an agent working in this project act differently because of it, and could it not learn it from the code, the docs or the tools?",
  "- One atomic fact per entry: two facts are two entries, never one with a joint title.",
  "- title: \u2264 8 words naming the fact. content: 1\u20132 lines, imperative, concrete (exact command, path, flag); it must not repeat the title.",
  "- Prefer reinforcing or updating an existing entry over adding a near-duplicate.",
  "- Deprecate an existing entry only when the notes clearly contradict it.",
  "- A decision needs a rationale (why, and what was rejected). Its content starts with the rule itself in one sentence: that sentence is what every session reads.",
  "- scope.paths: set it for any entry, a decision too, that only matters when working on part of the code; it then loads only there.",
  "- confidence: 0.9+ only for facts directly confirmed in the task (a command that ran, a decision the user approved); 0.5\u20130.7 for plausible but unverified; below 0.5 do not propose.",
  "- Most tasks teach nothing durable: then return no ops.",
  '- procedure: only for a multi-step workflow that is likely to recur; content is its numbered steps (exact commands), rationale is one full sentence saying when to use it ("Use when cutting a release.").',
  "- feedback: for existing entries the notes say were USED (helpful) or WRONG (harmful). Never guess: no mention, no feedback.",
  "",
  "Answer with ONE JSON object and nothing else:",
  '{"summary": "<one line: what this task taught, or why nothing>",',
  ' "ops": [',
  '  {"op":"add","type":"command|gotcha|decision|procedure","title":"<\u22648 words>","content":"<1\u20132 lines; numbered steps for a procedure>","rationale":"<why for a decision; for a procedure, one sentence saying when to use it>",',
  '   "scope":{"paths":["src/db/**"]},"evidence":[{"file":"<project-relative path>","anchor":"<script/symbol/heading>"}],',
  '   "confidence":0.0,"supersedes":["<id>"],"savings":{"toolCalls":0,"tokens":0}},',
  '  {"op":"update","id":"<id>","content":"<new content>","confidence":0.0},',
  '  {"op":"reinforce","id":"<id>"},',
  '  {"op":"deprecate","id":"<id>","reason":"<why>","confidence":0.0}',
  " ],",
  ' "feedback": [{"id":"<id>","verdict":"helpful|harmful"}]}',
  "Omit optional fields you have nothing for. savings: your estimate of tool calls and tokens a future similar task saves.",
  "Write titles and content in the language of the notes."
].join("\n");
var curatePrompt = (args) => {
  const existing = args.candidates.length ? args.candidates.map((e) => `- ${e.id} [${e.type}] ${e.title}: ${e.content.replace(/\n/g, " ")}`).join("\n") : "(none yet)";
  return [
    ...args.language && args.language !== "auto" ? [`LANGUAGE: write titles, content and rationale in ${args.language}.`, ""] : [],
    "EXISTING ENTRIES (most relevant):",
    existing,
    "",
    "TASK SIGNALS (measured):",
    args.signals,
    "",
    args.notesKind === "reflection" ? "NOTES FROM THE AGENT THAT DID THE TASK:" : "TASK DIGEST (messages and tool calls):",
    args.notes
  ].join("\n");
};

// src/analyzer/report.ts
var k = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
var mark = { add: "+", update: "~", reinforce: "\u2191", deprecate: "\u2212" };
var outcomeLine = (o) => `${mark[o.op.op] ?? "?"} [${o.type ?? "?"}] ${o.title ?? ""}${o.id ? ` \`${o.id}\`` : ""}${o.reason ? ` \u2014 ${o.reason}` : ""}`;
var savings = (r) => {
  let toolCalls = 0;
  let tokens2 = 0;
  for (const o of r.applied) {
    const s = "savings" in o.op ? o.op.savings : void 0;
    toolCalls += s?.toolCalls ?? 0;
    tokens2 += s?.tokens ?? 0;
  }
  return { toolCalls, tokens: tokens2 };
};
var statusLine = (r) => {
  const added = r.applied.filter((o) => o.op.op !== "reinforce").length;
  const parts = [added ? `+${added} ${added === 1 ? "entry" : "entries"}` : "nothing new"];
  if (r.proposals.length) parts.push(`${r.proposals.length} to review`);
  parts.push("/archivist");
  return `\u{1F4DA} ${parts.join(" \xB7 ")}`;
};
var reportMarkdown = (r) => {
  const s = r.signals;
  const u = s.usage;
  const sv = savings(r);
  const lines = [
    `# Archivist \xB7 ${r.title}`,
    "",
    `${r.ts} \xB7 session \`${r.session.slice(0, 8)}\` \xB7 ${s.turns} turns \xB7 ${Math.round(s.durationMs / 1e3)} s \xB7 tokens in ${k(u.input + u.cacheRead + u.cacheWrite)} (cached ${k(u.cacheRead)}) / out ${k(u.output)} \xB7 ${s.toolCalls} tool calls \xB7 ${s.readsBeforeFirstEdit} reads before first edit`,
    "",
    r.summary ? `**Takeaway:** ${r.summary}` : "",
    "",
    "## Added and changed",
    "",
    ...r.applied.length ? r.applied.map(outcomeLine) : ["Nothing: this task taught nothing durable."]
  ];
  if (r.proposals.length) lines.push("", "## Waiting for review", "", ...r.proposals.map(outcomeLine));
  if (r.rejected.length) lines.push("", "## Dropped", "", ...r.rejected.map(outcomeLine));
  if (sv.toolCalls || sv.tokens) lines.push("", `**Expected savings on a similar task:** \u2248 ${sv.toolCalls} tool calls, \u2248 ${k(sv.tokens)} tokens.`);
  if (r.written.length) lines.push("", "## Files", "", ...r.written.map((w) => `- \`${w}\``));
  const a = r.analysis;
  const cost = [a.reflect && `reflect in ${k(a.reflect.input + a.reflect.cacheRead)}/out ${k(a.reflect.output)}`, a.curate && `curate in ${k(a.curate.input)}/out ${k(a.curate.output)}`].filter(Boolean).join(", ");
  lines.push("", `_Analysis: ${a.notesKind}${cost ? `; ${cost}` : ""}${a.note ? `; ${a.note}` : ""}${a.error ? `; error: ${a.error}` : ""}_`, "");
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
};
var noticeText = (r) => {
  const head2 = statusLine(r);
  const items = r.applied.filter((o) => o.op.op !== "reinforce").slice(0, 4).map(outcomeLine);
  return [head2, ...items].join("\n");
};

// src/analyzer/signals.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var LOOK_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob", "LS"]);
var LOOK_COMMAND = /^(cat|head|tail|less|grep|rg|ag|find|fd|ls|tree|wc|sed -n|awk|jq)\b/;
var CORRECTION = /(^|[\s,.!])(нет[,.!]|не так|неправильно|не надо|не нужно|запомни|remember[:,]|no[,.!]\s|wrong|don't|do not|instead)/i;
var lastStep2 = (cmd) => (cmd.split(/&&|;/).at(-1) ?? cmd).trim();
var head = (cmd) => lastStep2(cmd).split(/\s+/)[0] ?? "";
var computeSignals = (seg2) => {
  const edits = [];
  let readsBeforeFirstEdit = 0;
  const reads = /* @__PURE__ */ new Map();
  const failed = [];
  const recovered = [];
  const open = [];
  for (const t of seg2.tools) {
    if (EDIT_TOOLS.has(t.tool)) {
      if (t.target && !edits.includes(t.target)) edits.push(t.target);
    } else if (LOOK_TOOLS.has(t.tool)) {
      if (!edits.length) readsBeforeFirstEdit++;
      if (t.tool === "Read" && t.target) reads.set(t.target, (reads.get(t.target) ?? 0) + 1);
    } else if (t.tool === "Bash" && t.target) {
      if (t.ok && LOOK_COMMAND.test(lastStep2(t.target))) {
        if (!edits.length) readsBeforeFirstEdit++;
        continue;
      }
      if (!t.ok) {
        failed.push({ command: t.target, ...t.error ? { error: t.error } : {} });
        open.push(t.target);
      } else {
        const i = open.findIndex((f) => head(f) === head(t.target));
        if (i >= 0) {
          recovered.push({ failed: open[i], succeeded: t.target });
          open.splice(i, 1);
        }
      }
    }
  }
  return {
    turns: seg2.turns.length,
    durationMs: seg2.turns.reduce((s, t) => s + t.durationMs, 0),
    usage: seg2.turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage()),
    toolCalls: seg2.tools.length,
    edits,
    readsBeforeFirstEdit,
    repeatedReads: [...reads].filter(([, n]) => n > 1).map(([file, times]) => ({ file, times })),
    failedCommands: failed,
    recoveredCommands: recovered,
    corrections: seg2.prompts.slice(1).filter((p) => CORRECTION.test(p)),
    rulesLoaded: [...new Set(seg2.rulesLoaded.map((r) => r.file))]
  };
};
var isTrivial = (s, config) => s.toolCalls < config.analyzer.minToolCalls && s.edits.length === 0 && s.corrections.length === 0 && s.failedCommands.length === 0;
var signalsText = (s) => {
  const lines = [
    `turns: ${s.turns}, tool calls: ${s.toolCalls}, files edited: ${s.edits.length}, reads before first edit: ${s.readsBeforeFirstEdit}`
  ];
  if (s.edits.length) lines.push(`edited: ${s.edits.slice(0, 20).join(", ")}`);
  if (s.repeatedReads.length) lines.push(`re-read: ${s.repeatedReads.map((r) => `${r.file}\xD7${r.times}`).join(", ")}`);
  for (const f of s.failedCommands.slice(0, 10)) lines.push(`failed command: ${f.command}${f.error ? ` \u2192 ${f.error}` : ""}`);
  for (const r of s.recoveredCommands) lines.push(`recovered: \`${r.failed}\` failed, then \`${r.succeeded}\` worked`);
  for (const c of s.corrections.slice(0, 5)) lines.push(`user correction?: ${c.slice(0, 200)}`);
  if (s.rulesLoaded.length) lines.push(`archivist rules loaded: ${s.rulesLoaded.join(", ")}`);
  return lines.join("\n");
};

// src/analyzer/pipeline.ts
var DOCS = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "README.md", "CLAUDE.local.md"];
var TOP_K = 15;
var toUsage = (u) => addUsage(emptyUsage(), u ?? {});
var CANDIDATES = ".archivist/.local/procedure-candidates.jsonl";
var readLines = async (io, path) => (await io.read(path) ?? "").split("\n").filter(Boolean);
var writeProposal = async (io, ts, i, src, op, reason) => {
  const path = joinPath(PATHS.proposals, `${ts.replace(/[:.]/g, "-")}-${i}.json`);
  await io.write(path, JSON.stringify({ ts, src, op, reason: reason ?? null }, null, 2) + "\n");
  return path;
};
var pickCandidates = (entries, seg2, edits, k2 = TOP_K) => {
  const scoped = entries.filter((e) => e.scope?.paths.some((g) => edits.some((f) => globToRegExp(g).test(f))));
  const query = [...seg2.prompts, ...edits, ...seg2.tools.map((t) => t.target ?? "")].join(" ");
  const ranked = bm25(entries.map((e) => `${e.title} ${e.content} ${e.scope?.paths.join(" ") ?? ""}`), query).map((r) => entries[r.index]);
  const out = [];
  for (const e of [...scoped, ...ranked]) if (!out.includes(e) && out.length < k2) out.push(e);
  return out;
};
var committed = async (io, segment) => (await loadAnalyses(io)).some((a) => a.segment === segment) || parseLedger(await io.read(PATHS.ledger) ?? "").records.some((r) => r.src?.segment === segment) || (await listProposals(io)).some((p) => p.src?.segment === segment);
var readDocs = async (io) => {
  const out = [];
  for (const p of DOCS) {
    const t = await io.read(p);
    if (t) out.push(t.slice(0, 5e4));
  }
  return out;
};
var analyzeSegment = async (args) => {
  const { io, llm, config, segment: seg2, now } = args;
  const ts = now.toISOString();
  const signals = computeSignals(seg2);
  let usage = emptyUsage();
  const pre = await withLock(io, async () => {
    if (await committed(io, seg2.id)) {
      await renderAll(io, (await loadState(io)).entries, config);
      return void 0;
    }
    const state2 = await loadState(io);
    const active2 = activeEntries(state2.entries);
    const loaded = new Set(signals.rulesLoaded);
    const seen2 = [...groupAreas(active2)].filter(([path]) => loaded.has(path)).flatMap(([, a]) => a.items.map((e) => e.id));
    const used2 = commandsUsed(active2, seg2.tools);
    if (!(await loadMetrics(io)).some((m) => m.segment === seg2.id)) {
      await appendMetrics(io, { ...toMetrics(signals, ts, "live"), segment: seg2.id });
      const counters = await loadUsage(io);
      recordUse(counters, { seen: seen2, used: used2, feedback: [], known: new Set(active2.map((e) => e.id)), ts });
      await saveUsage(io, counters);
    }
    const expired2 = await expireProposals(io, config, now);
    const trivial = isTrivial(signals, config);
    if (trivial) await appendAnalysis(io, { ts, segment: seg2.id, outcome: "skipped", applied: 0, proposals: 0, dropped: 0, tokens: 0 });
    return { state: state2, active: active2, seen: seen2, used: used2, expired: expired2, trivial };
  });
  if (!pre) return { kind: "skipped", reason: "already analysed", usage };
  if (pre.trivial) return { kind: "skipped", reason: "trivial task", usage };
  const { state, active, seen, used, expired } = pre;
  const candidates = pickCandidates(active, seg2, signals.edits);
  const inPlay = [];
  for (const e of [...[...seen, ...used].map((id) => state.entries.get(id)), ...candidates]) if (!inPlay.includes(e) && inPlay.length < 20) inPlay.push(e);
  let notes = "";
  let notesKind = "digest";
  let reflectUsage;
  let error;
  const tooBig = (args.contextTokens ?? 0) > config.analyzer.forkMaxContextTokens;
  const note = [tooBig ? `reflect skipped: context ${args.contextTokens} tokens > ${config.analyzer.forkMaxContextTokens}` : "", expired.length ? `${expired.length} unreviewed proposals expired` : ""].filter(Boolean).join("; ") || void 0;
  if (config.analyzer.reflect === "fork" && llm.reflect && args.messages && !tooBig) {
    const r = await llm.reflect(reflectPrompt(seg2.prompts[0], config.language, inPlay));
    reflectUsage = toUsage(r.usage);
    usage = addUsage(usage, reflectUsage);
    if (r.ok && r.text.trim()) {
      notes = r.text.trim();
      notesKind = "reflection";
    } else if (!r.ok) error = `reflect: ${r.reason}`;
  }
  if (!notes) notes = args.messages ? digestFromMessages(sliceTask(args.messages, seg2.prompts[0])) : digestFromSegment(seg2);
  notes = redact(notes).text;
  const c = await llm.complete({ system: CURATE_SYSTEM, prompt: curatePrompt({ notes, notesKind, signals: signalsText(signals), candidates: inPlay, language: config.language }), maxTokens: 2500 });
  const curateUsage = toUsage(c.usage);
  usage = addUsage(usage, curateUsage);
  const reply = c.ok ? parseCuratorReply(c.text) : void 0;
  if (!c.ok) error = [error, `curate: ${c.reason}`].filter(Boolean).join("; ");
  else if (!reply) error = [error, "curate: reply was not JSON"].filter(Boolean).join("; ");
  return withLock(io, async () => {
    const state2 = await loadState(io);
    const known = new Set(activeEntries(state2.entries).map((e) => e.id));
    const src = { segment: seg2.id };
    const v = await validateOps({
      ops: reply?.ops ?? [],
      entries: state2.entries,
      io,
      config,
      docs: await readDocs(io),
      now: ts,
      src,
      skipped: await loadSkipped(io),
      procedureCandidates: (await readLines(io, CANDIDATES)).map((l) => JSON.parse(l).text),
      pending: (await listProposals(io)).map((p) => ({ id: p.id, op: p.op }))
    });
    for (const p of (await listProposals(io)).filter((p2) => v.promoted.includes(p2.id))) await io.remove?.(p.path);
    await appendLedger(io, v.records);
    if (v.firstSightings.length)
      await io.write(CANDIDATES, (await io.read(CANDIDATES) ?? "") + v.firstSightings.map((text) => JSON.stringify({ ts, text })).join("\n") + "\n");
    const { written, removed } = await renderAll(io, (await loadState(io)).entries, config);
    written.push(...removed.map((r) => `${r} (removed)`));
    const reinforced = v.applied.filter((o) => o.op.op === "reinforce" && o.id).map((o) => o.id);
    const counters = await loadUsage(io);
    const harmful = recordUse(counters, { seen: [], used: reinforced, feedback: reply?.feedback ?? [], known, ts });
    await saveUsage(io, counters);
    const proposals = [...v.proposals];
    const pending = new Set((await listProposals(io)).filter((p) => p.op.op === "deprecate").map((p) => "id" in p.op ? p.op.id : ""));
    for (const id of harmful.filter((h) => !pending.has(h))) {
      const e = state2.entries.get(id);
      const reason = `judged wrong in ${counters[id].harmful} tasks, helpful in ${counters[id].helpful}`;
      proposals.push({ op: { op: "deprecate", id, reason, confidence: 0.7 }, id, type: e.type, title: e.title, reason });
    }
    for (const [i, p] of proposals.entries()) written.push(await writeProposal(io, ts, i, src, p.op, p.reason));
    const report = {
      ts,
      session: seg2.session,
      segment: seg2.id,
      title: truncate((seg2.prompts[0] ?? "task").replace(/\s+/g, " "), 80),
      summary: reply?.summary ?? "",
      signals,
      applied: v.applied,
      proposals,
      rejected: v.rejected,
      written,
      analysis: { notesKind, ...reflectUsage ? { reflect: reflectUsage } : {}, curate: curateUsage, ...note ? { note } : {}, ...error ? { error } : {} }
    };
    const reportPath = joinPath(PATHS.reports, `${ts.replace(/[:.]/g, "-")}.md`);
    await io.write(reportPath, reportMarkdown(report));
    await appendAnalysis(io, {
      ts,
      segment: seg2.id,
      outcome: "done",
      applied: v.applied.filter((o) => o.op.op !== "reinforce").length,
      proposals: proposals.length,
      dropped: v.rejected.length,
      tokens: weightedTokens(usage),
      ...error ? { error } : {}
    });
    return { kind: "done", report, reportPath, usage };
  });
};

// src/core/attempts.ts
var MAX_FAILURES = 3;
var afterFailure = (failures = 0) => ({
  failures: failures + 1,
  drop: failures + 1 >= MAX_FAILURES
});

// src/core/hold.ts
var CREDIT_WINDOWS = /* @__PURE__ */ new Set(["five_hour", "seven_day"]);
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var pad = (n) => String(n).padStart(2, "0");
var clockText = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
var statusText = (until, why, hint) => `\u{1F4DA} analysis waits${until ? ` till ${clockText(until)}` : ""} (${why})${hint ? ` \xB7 ${hint}` : ""}`;
var holdOf = (spent, limits, analyzer, now) => {
  if (spent >= analyzer.maxTokensPerDay) {
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return {
      reason: `daily budget used (${spent}/${analyzer.maxTokensPerDay})`,
      status: statusText(midnight, "daily budget used", "raise analyzer.maxTokensPerDay")
    };
  }
  const full = limits.filter((l) => l.percentUsed >= analyzer.maxRateLimitPercent).filter((l) => !(analyzer.useCredits && CREDIT_WINDOWS.has(l.kind)));
  if (!full.length) return void 0;
  const resets = full.map((l) => l.resetsAt ? Date.parse(l.resetsAt) : NaN);
  const until = resets.some(Number.isNaN) ? void 0 : new Date(Math.max(...resets));
  const why = full.map((l) => `${l.kind} limit at ${l.percentUsed}%`).join(", ");
  const onCredits = full.every((l) => CREDIT_WINDOWS.has(l.kind));
  return {
    reason: full.map((l) => `${l.kind} rate limit at ${l.percentUsed}%`).join(", "),
    status: statusText(until, why, onCredits ? "analyzer.useCredits runs it on credits" : void 0)
  };
};

// src/adapters/claude/mod/register.ts
var SEG_KEY = "archivist:seg:";
var BUDGET_KEY = "archivist:budget:";
var LAST_KEY = "archivist:last:";
var RETRY_MS = 15 * 6e4;
var BUSY_RETRY_MS = 6e4;
var FORK_TIMEOUT_MS = 12e4;
var segKey = (s) => `${SEG_KEY}${s.session}:${s.id}`;
var toUsage2 = (u) => ({
  input: u?.input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0
});
var today = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
var toolTarget = (root2, tool, input, exclude) => {
  const i = input ?? {};
  const v = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path ?? i.url;
  if (typeof v !== "string") return void 0;
  if (tool === "Bash") return redact(truncate(v.replace(/\s+/g, " ").trim(), 200)).text;
  const rel = relPath(root2, v);
  return isExcluded(rel, exclude) ? void 0 : rel;
};
var root = "";
var session = "";
var cfg = DEFAULT_CONFIG;
var seg;
var idle;
var analysing = false;
var notice;
var ownTurnPending = false;
var lastStatus;
var statusKind;
var ownTurns = /* @__PURE__ */ new Set();
var newSegment = () => ({
  id: Date.now().toString(36),
  session,
  startedAt: Date.now(),
  prompts: [],
  answers: [],
  turns: [],
  tools: [],
  rulesLoaded: []
});
function makeIo($, base) {
  const abs = (p) => joinPath(base, p);
  return withLocalIgnored({
    root: base,
    async read(p) {
      return await $.fs.exists(abs(p)) ? await $.fs.read(abs(p)) : void 0;
    },
    async write(p, text) {
      await $.fs.write(abs(p), text);
    },
    async remove(p) {
      await $.process.run(["rm", "-f", abs(p)]);
    },
    async removeEmptyDir(p) {
      await $.process.run(["rmdir", abs(p)]);
    },
    async exists(p) {
      return await $.fs.exists(abs(p));
    },
    async list(dir) {
      if (!await $.fs.exists(abs(dir))) return [];
      const entries = await $.fs.list(abs(dir));
      return entries.map((e) => e.name);
    },
    // $.fs has no exclusive create: mkdir through the shell is the atomic step, and fails when the lock exists.
    mutex: {
      async claim(p) {
        await $.process.run(["mkdir", "-p", abs(p).replace(/\/[^/]+$/, "")]);
        return (await $.process.run(["mkdir", abs(p)])).exitCode === 0;
      },
      async age(p) {
        try {
          return Date.now() - (await $.fs.stat(abs(p))).mtimeMs;
        } catch {
          return void 0;
        }
      },
      async release(p) {
        await $.process.run(["rmdir", abs(p)]);
      },
      async sleep(ms) {
        await $.clock.sleep(ms);
      }
    }
  });
}
async function log($, project, line) {
  const key = logKey(project);
  await $.store.set(key, withLine(await $.store.get(key), line, /* @__PURE__ */ new Date()));
}
function makeLlm($, config) {
  const reply = (r) => r.isAnswered ? { ok: true, text: r.text, usage: toUsage2(r.usage) } : { ok: false, reason: String(r.reason), usage: toUsage2(r.usage) };
  return {
    async reflect(prompt) {
      const timeout = $.clock.sleep(FORK_TIMEOUT_MS).then(() => ({ isAnswered: false, reason: "timeout" }));
      return reply(await Promise.race([$.model.fork({ prompt }), timeout]));
    },
    async complete({ system, prompt, maxTokens }) {
      return reply(
        await $.model.complete({
          model: config.analyzer.curateModel,
          system: [{ text: system, cache: true }],
          prompt,
          maxTokens,
          timeoutMs: 12e4
        })
      );
    }
  };
}
async function saveSegment($) {
  if (seg) await $.store.set(segKey(seg), { root, seg });
}
async function readMessages($) {
  const list = await $.session.messages();
  return list.map((m) => ({
    role: m.role,
    text: m.text ?? "",
    toolUses: (m.toolUses ?? []).map((t) => ({ tool: t.tool, input: t.input ?? {}, isError: t.isError, text: t.text }))
  }));
}
function showStatus($, text, kind) {
  lastStatus = text;
  statusKind = kind;
  $.ui.status(text);
}
async function refreshStatus($, io) {
  const state = await loadState(io);
  const n = activeEntries(state.entries).length;
  const queued = (await listProposals(io)).length;
  showStatus($, countsText(n, queued), "counts");
}
async function analyse($, stored, current) {
  const s = stored.seg;
  if (analysing) {
    await log($, stored.root, `seg ${s.id}: another analysis is running, retry later`);
    $.clock.after(BUSY_RETRY_MS, async () => analyse($, stored, current));
    return;
  }
  analysing = true;
  try {
    if (!await $.store.get(segKey(s))) {
      await log($, stored.root, `seg ${s.id}: already analysed, skipped`);
      return;
    }
    const io = makeIo($, stored.root);
    const config = await loadConfig(io);
    await log($, stored.root, `seg ${s.id}: start (${s.turns.length} turns, ${s.tools.length} tool calls, current=${current})`);
    if (!config.enabled) {
      await $.store.delete(segKey(s));
      await log($, stored.root, `seg ${s.id}: archivist disabled for this project, dropped`);
      return;
    }
    const spentKey = BUDGET_KEY + today();
    const spent = await $.store.get(spentKey) ?? 0;
    const usage = await $.session.usage();
    const held = holdOf(spent, usage.rateLimits ?? [], config.analyzer, /* @__PURE__ */ new Date());
    if (held) {
      await log($, stored.root, `seg ${s.id}: postponed: ${held.reason}`);
      showStatus($, held.status, "event");
      $.clock.after(RETRY_MS, async () => analyse($, stored, current));
      return;
    }
    showStatus($, "\u{1F4DA} analysing the last task\u2026", "event");
    const result = await analyzeSegment({
      io,
      llm: makeLlm($, config),
      config,
      segment: s,
      ...current ? { messages: await readMessages($), contextTokens: usage.context?.tokens ?? 0 } : {},
      now: /* @__PURE__ */ new Date()
    });
    await $.store.delete(segKey(s));
    await $.store.set(spentKey, spent + weightedTokens(result.usage));
    await log(
      $,
      stored.root,
      result.kind === "skipped" ? `seg ${s.id}: skipped: ${result.reason}` : `seg ${s.id}: done: ${result.report.applied.length} applied, ${result.report.proposals.length} proposals, ${result.report.rejected.length} dropped, ${weightedTokens(result.usage)} weighted tokens${result.report.analysis.error ? `; ${result.report.analysis.error}` : ""} \u2192 ${result.reportPath}`
    );
    if (result.kind === "skipped") {
      await refreshStatus($, io);
      return;
    }
    await $.store.set(LAST_KEY + stored.root, result.reportPath);
    notice = noticeText(result.report);
    showStatus($, statusLine(result.report), "result");
    $.ui.toast(statusLine(result.report), { timeoutMs: config.report.toastMs });
    if (config.report.mode === "rewake" && current) {
      ownTurnPending = true;
      await $.prompt.submit({
        text: `Archivist report (informational; the task is finished, do not resume it). Tell the user in two or three lines what was recorded:

${notice}`
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}
${err.stack ?? ""}` : String(err);
    const kept = await $.store.get(segKey(s));
    const { failures, drop } = afterFailure(kept?.failures);
    if (drop) await $.store.delete(segKey(s));
    else if (kept) await $.store.set(segKey(s), { ...kept, failures });
    await log(
      $,
      stored.root,
      `seg ${s.id}: failed (${failures}/${MAX_FAILURES}${drop ? ", given up" : ", retried at the next session start"}): ${msg}`
    );
    showStatus($, "\u{1F4DA} analysis failed: /archivist log", "event");
  } finally {
    analysing = false;
  }
}
function register(on) {
  on("session.start", async ($, e, next) => {
    root = await $.session.root();
    session = await $.session.id();
    cfg = await loadConfig(makeIo($, root));
    await $.command.register({
      name: "archivist",
      description: "Archivist: what it learned from the last task (report) or the knowledge base status (status)",
      argumentHint: "[report|status|health|stats|recall <words>|review|apply <n>|skip <n>|edit <id> \u2026|deprecate <id> --reason \u2026|log]"
    });
    const waiting = /* @__PURE__ */ new Map();
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SEG_KEY)) continue;
      const s = await $.store.get(key);
      if (s?.root !== root) continue;
      if (key !== segKey(s.seg)) {
        await $.store.set(segKey(s.seg), s);
        await $.store.delete(key);
      }
      waiting.set(segKey(s.seg), { stored: s, current: s.seg.session === session });
    }
    if (waiting.size) {
      await log($, root, `session.start: ${waiting.size} task(s) waiting for analysis`);
      const config = await loadConfig(makeIo($, root));
      $.clock.after(config.analyzer.idleSeconds * 1e3, async () => {
        for (const w of waiting.values()) await analyse($, w.stored, w.current);
      });
    }
    await refreshStatus($, makeIo($, root));
    return next(e);
  }).catch(($, e, next) => next(e));
  on("session.attach", async ($, e, next) => {
    const r = await next(e);
    if (root && shouldRecount(statusKind)) await refreshStatus($, makeIo($, root));
    else if (lastStatus) $.ui.status(lastStatus);
    return r;
  }).catch(($, e, next) => next(e));
  on("turn.start", async ($, e, next) => {
    if (e.agentId !== void 0) return next(e);
    if (ownTurnPending) {
      ownTurnPending = false;
      ownTurns.add(e.turnId);
      return next(e);
    }
    idle?.cancel();
    idle = void 0;
    seg ??= newSegment();
    seg.prompts.push(e.text);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PostToolUse", async ($, e, next) => {
    if (seg) {
      const ev = { tool: e.tool_name, ok: true };
      const target = toolTarget(root, e.tool_name, e.tool_input, cfg.privacy.excludePaths);
      if (target) ev.target = target;
      if (e.duration_ms !== void 0) ev.durationMs = e.duration_ms;
      if (e.agent_id) ev.agent = e.agent_id;
      seg.tools.push(ev);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PostToolUseFailure", async ($, e, next) => {
    if (seg && !e.is_interrupt) {
      const ev = { tool: e.tool_name, ok: false, error: redact(truncate(e.error.replace(/\s+/g, " "), 300)).text };
      const target = toolTarget(root, e.tool_name, e.tool_input, cfg.privacy.excludePaths);
      if (target) ev.target = target;
      if (e.agent_id) ev.agent = e.agent_id;
      seg.tools.push(ev);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.InstructionsLoaded", async ($, e, next) => {
    if (seg && e.file_path.includes(PATHS.rulesDir)) {
      const r = { file: relPath(root, e.file_path) };
      if (e.trigger_file_path) r.trigger = relPath(root, e.trigger_file_path);
      seg.rulesLoaded.push(r);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId !== void 0 || ownTurns.has(e.turnId)) return r;
    if (seg) {
      seg.turns.push({ turnId: e.turnId, durationMs: e.durationMs, usage: addUsage(emptyUsage(), toUsage2(e.usage)) });
      if (e.answer) seg.answers.push(truncate(e.answer, 2e3));
      await saveSegment($);
      const config = cfg = await loadConfig(makeIo($, root));
      if (config.enabled) {
        idle?.cancel();
        idle = $.clock.after(config.analyzer.idleSeconds * 1e3, async () => {
          idle = void 0;
          const s = seg;
          if (!s) return;
          seg = void 0;
          await analyse($, { root, seg: s }, true);
        });
      }
    }
    if (root && shouldRecount(statusKind)) await refreshStatus($, makeIo($, root));
    else if (lastStatus) $.ui.status(lastStatus);
    if (!notice) return r;
    const text = notice;
    notice = void 0;
    return { ...r, text };
  }).catch(($, e, next) => next(e));
  on("command.run", { command: "archivist" }, async ($, e) => {
    const io = makeIo($, root);
    const [verb = "report", ...rest] = splitArgs(e.args);
    if (verb === "log") {
      const lines = await $.store.get(logKey(root)) ?? [];
      return { text: lines.length ? [`Archivist log for ${root}:`, ...lines.slice(-30)].join("\n") : `Archivist log for ${root} is empty.` };
    }
    if (verb === "review") return { text: reviewText(await listProposals(io)) };
    if (verb === "edit" || verb === "deprecate") {
      const { words, opts } = parseOptions(rest);
      const id = words[0];
      if (!id) return { text: `Usage: /archivist ${verb === "edit" ? 'edit <id> [--title "\u2026"] [--content "\u2026"] [--why "\u2026"] [--paths "a/**,b/**"]' : 'deprecate <id> --reason "\u2026"'}` };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const r = verb === "deprecate" ? await deprecateEntry(io, cfg, id, opts.reason ?? "", now) : await editEntry(io, cfg, id, editFromOptions(opts), now);
      await refreshStatus($, io);
      return { text: r.ok ? `${verb === "edit" ? "Updated" : "Retired"} \`${r.entry.id}\`: ${r.entry.title}` : `Not changed: ${r.reason}` };
    }
    if (verb === "stats") return { text: await statsText(io, (await loadState(io)).entries) };
    if (verb === "health")
      return {
        text: await healthText(io, (await loadState(io)).entries, cfg, /* @__PURE__ */ new Date(), {
          log: await $.store.get(logKey(root)) ?? [],
          spentToday: await $.store.get(BUDGET_KEY + today()) ?? 0
        })
      };
    if (verb === "recall") return { text: recallText((await loadState(io)).entries, rest.join(" ")) };
    if (verb === "apply" || verb === "skip") {
      const chosen = pick(await listProposals(io), rest.join(","));
      if (!chosen.length) return { text: `Usage: /archivist ${verb} <n|1,3|all> \u2014 numbers from /archivist review.` };
      const now = (/* @__PURE__ */ new Date()).toISOString();
      if (verb === "skip") {
        await skipProposals(io, chosen, now);
        await refreshStatus($, io);
        return { text: `Skipped: ${chosen.map((p) => describeOp(p.op)).join("; ")}. The same ideas will not be proposed again.` };
      }
      const outcomes = await applyProposals(io, cfg, chosen, now);
      await refreshStatus($, io);
      return { text: ["Recorded:", ...outcomes.map((o) => `- ${o.title ?? ""}${o.id ? ` \`${o.id}\`` : ""}${o.reason ? ` (${o.reason})` : ""}`)].join("\n") };
    }
    if (verb === "status") {
      const state = await loadState(io);
      const active = activeEntries(state.entries);
      const by = (t) => active.filter((x) => x.type === t).length;
      const queued = (await listProposals(io)).length;
      const open = seg ? `open task: ${seg.turns.length} turns, ${seg.tools.length} tool calls` : "no open task";
      return {
        text: [
          `Archivist: ${active.length} active entries (${by("command")} commands, ${by("gotcha")} gotchas, ${by("decision")} decisions)`,
          `${queued} proposals waiting for review: /archivist review`,
          open,
          state.badLines.length ? `ledger: ${state.badLines.length} unreadable lines` : ""
        ].filter(Boolean).join("\n")
      };
    }
    const path = await $.store.get(LAST_KEY + root);
    const text = path ? await io.read(path) : void 0;
    return { text: text ?? "Archivist has no report yet: it writes one after a task that taught something." };
  });
}
export {
  register
};
