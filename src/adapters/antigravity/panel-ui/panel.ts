import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

interface ProposalView {
  id: string;
  fingerprint: string;
  human: boolean;
  kind: string;
  title: string;
  content: string;
  rationale?: string;
  reason: string | null;
}

interface EntryView {
  id: string;
  type: string;
  title: string;
  content: string;
  rationale?: string;
  paths: string[];
  updated: string;
}

interface Snapshot {
  root: string | null;
  project: string;
  projects: { root: string; name: string; updatedAt: string }[];
  initialized: boolean;
  enabled: boolean;
  counts: { entries: number; deprecated: number; review: number; reports: number };
  entries: EntryView[];
  matching: number;
  proposals: ProposalView[];
  analysis: { enabled: boolean; tasks: { state: string; message: string; updatedAt: number }[] };
  collection: {
    sessions: number;
    events: number;
    counts: Record<string, number>;
    modelCallsUpperBound: number;
    contentCaptured: boolean;
    analysisEnabled: boolean;
  };
  reports: string[];
  updatedAt: string;
  tab?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const state: {
  root: string;
  tab: string;
  type: string;
  query: string;
  snapshot: Snapshot | null;
  selectedReport: string;
  busy: boolean;
  refreshing: boolean;
} = {
  root: "",
  tab: "entries",
  type: "",
  query: "",
  snapshot: null,
  selectedReport: "",
  busy: false,
  refreshing: false,
};

const app = new App({ name: "Archivist", version: "1.9.2" }, {});

const applyHost = (ctx: ReturnType<App["getHostContext"]>) => {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await app.callServerTool({ name, arguments: args });
  const structured = (res.structuredContent ?? {}) as Record<string, unknown>;
  if (res.isError || structured.ok === false) {
    const firstText = Array.isArray(res.content)
      ? res.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text
      : undefined;
    throw new Error(
      (typeof structured.error === "string" && structured.error) || firstText || `Tool ${name} failed`,
    );
  }
  return structured as T;
}

let toastTimer: number | undefined;
function showToast(text: string, isError = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = isError ? "toast error" : "toast";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 3500);
}

const TYPE_LABELS: Record<string, string> = {
  command: "Команда",
  gotcha: "Ловушка",
  decision: "Решение",
  procedure: "Процедура",
};

function setActiveTab(tab: string) {
  if (!["entries", "proposals", "reports", "tools"].includes(tab)) return;
  state.tab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    const active = t.dataset.tab === state.tab;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
}

function renderProjects(snap: Snapshot) {
  const select = $<HTMLSelectElement>("project-select");
  const items = snap.projects || [];
  select.replaceChildren();
  if (!items.length && !snap.root) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Нет зарегистрированных проектов";
    select.append(opt);
    return;
  }
  for (const p of items) {
    const opt = document.createElement("option");
    opt.value = p.root;
    opt.textContent = `${p.name} — ${p.root}`;
    if (p.root === snap.root) opt.selected = true;
    select.append(opt);
  }
  if (snap.root && !items.some((p) => p.root === snap.root)) {
    const opt = document.createElement("option");
    opt.value = snap.root;
    opt.textContent = `${snap.project} — ${snap.root}`;
    opt.selected = true;
    select.append(opt);
  }
}

function renderStatus(snap: Snapshot) {
  $("project-path").textContent = snap.root || "Проект не выбран";
  $("count-entries").textContent = String(snap.counts.entries);
  const rev = $("count-review");
  rev.textContent = String(snap.counts.review);
  rev.className = snap.counts.review > 0 ? "badge attention" : "badge";
  $("count-reports").textContent = String(snap.counts.reports);

  const dot = $("status-dot");
  const label = $("analysis-label");
  const sub = $("analysis-sub");
  const btnToggle = $("btn-toggle-analysis");
  const btnRun = $("btn-run-analysis");

  if (!snap.root) {
    dot.className = "dot";
    label.textContent = "Ожидание проекта";
    sub.textContent = "Откройте проект или добавьте путь вручную";
    btnToggle.classList.add("hidden");
    btnRun.classList.add("hidden");
    return;
  }

  btnToggle.classList.remove("hidden");
  btnToggle.textContent = snap.analysis.enabled ? "Выкл. анализ" : "Вкл. анализ";
  btnRun.classList.toggle("hidden", !snap.analysis.enabled);

  const latest = snap.analysis.tasks[0];
  if (!snap.analysis.enabled) {
    dot.className = "dot";
    label.textContent = "Фоновый анализ выключен";
    sub.textContent = `Событий собрано: ${snap.collection.events} · Сессий: ${snap.collection.sessions}`;
  } else if (latest && (latest.state === "analysing" || latest.state === "pending")) {
    dot.className = "dot warn";
    label.textContent = latest.message;
    sub.textContent = `Сессий: ${snap.collection.sessions} · Событий: ${snap.collection.events}`;
  } else if (latest && latest.state === "failed") {
    dot.className = "dot danger";
    label.textContent = latest.message;
    sub.textContent = "Проверьте авторизацию agy CLI в терминале";
  } else {
    dot.className = "dot ok";
    label.textContent = latest?.message || "Фоновый анализ включён";
    sub.textContent = `Обновлено ${new Date(snap.updatedAt).toLocaleTimeString("ru-RU")} · событий: ${snap.collection.events}`;
  }
}

function renderEntries(snap: Snapshot) {
  const list = $("entries-list");
  list.replaceChildren();
  if (!snap.entries.length) {
    const p = document.createElement("p");
    p.className = "subtle";
    p.style.textAlign = "center";
    p.style.padding = "24px 0";
    p.textContent =
      state.query || state.type
        ? "По фильтру ничего не найдено."
        : "Записей пока нет. Нажмите «+ Запись» или запустите init.";
    list.append(p);
    return;
  }
  for (const item of snap.entries) {
    const card = document.createElement("article");
    card.className = "card";

    const meta = document.createElement("div");
    meta.className = "meta-row";
    const pill = document.createElement("span");
    pill.className = `pill ${item.type}`;
    pill.textContent = TYPE_LABELS[item.type] || item.type;

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "8px";

    const idSpan = document.createElement("span");
    idSpan.className = "subtle";
    idSpan.textContent = item.id;

    const depBtn = document.createElement("button");
    depBtn.type = "button";
    depBtn.className = "btn btn-ghost btn-xs";
    depBtn.textContent = "Убрать";
    depBtn.title = "Вывести запись из правил (deprecate)";

    const depForm = document.createElement("form");
    depForm.className = "inline-form hidden";
    const depInput = document.createElement("input");
    depInput.className = "input";
    depInput.type = "text";
    depInput.value = "Устарело";
    depInput.placeholder = "Причина вывода из правил";
    const depOk = document.createElement("button");
    depOk.type = "submit";
    depOk.className = "btn btn-danger btn-xs";
    depOk.textContent = "Вывести";
    const depCancel = document.createElement("button");
    depCancel.type = "button";
    depCancel.className = "btn btn-ghost btn-xs";
    depCancel.textContent = "✕";
    depForm.append(depInput, depOk, depCancel);

    depBtn.addEventListener("click", () => {
      depForm.classList.toggle("hidden");
      if (!depForm.classList.contains("hidden")) depInput.focus();
    });
    depCancel.addEventListener("click", () => depForm.classList.add("hidden"));
    depForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!snap.root) return;
      try {
        const res = await callTool<{ text: string }>("panel_deprecate", {
          root: snap.root,
          id: item.id,
          reason: depInput.value.trim() || "Устарело",
        });
        showToast(res.text);
        await refresh();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), true);
      }
    });

    right.append(idSpan, depBtn);
    meta.append(pill, right);

    const h3 = document.createElement("h3");
    h3.textContent = item.title;

    const body = document.createElement("p");
    body.textContent = item.content;

    card.append(meta, h3, body);

    if (item.rationale) {
      const why = document.createElement("p");
      why.className = "subtle";
      why.textContent = `Почему: ${item.rationale}`;
      card.append(why);
    }

    if (item.paths && item.paths.length) {
      const tags = document.createElement("div");
      tags.className = "path-list";
      for (const p of item.paths) {
        const tag = document.createElement("span");
        tag.className = "path-tag";
        tag.textContent = p;
        tags.append(tag);
      }
      card.append(tags);
    }
    card.append(depForm);
    list.append(card);
  }
}

function renderProposals(snap: Snapshot) {
  const list = $("proposals-list");
  list.replaceChildren();
  if (!snap.proposals.length) {
    const p = document.createElement("p");
    p.className = "subtle";
    p.style.textAlign = "center";
    p.style.padding = "24px 0";
    p.textContent = "Очередь ревью пуста. Новые предложения появятся после фонового анализа задач.";
    list.append(p);
    return;
  }
  for (const p of snap.proposals) {
    const card = document.createElement("article");
    card.className = "card";

    const meta = document.createElement("div");
    meta.className = "meta-row";
    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.gap = "6px";
    left.style.flexWrap = "wrap";

    const kind = document.createElement("span");
    kind.className = "pill";
    kind.textContent = p.kind;
    left.append(kind);

    if (p.human) {
      const human = document.createElement("span");
      human.className = "pill human";
      human.textContent = "Решение человека";
      left.append(human);
    }

    const idSpan = document.createElement("span");
    idSpan.className = "subtle id-label";
    idSpan.textContent = p.id;
    idSpan.title = p.id;
    meta.append(left, idSpan);

    const h3 = document.createElement("h3");
    h3.textContent = p.title;
    const body = document.createElement("p");
    body.textContent = p.content;

    card.append(meta, h3, body);

    if (p.rationale) {
      const why = document.createElement("p");
      why.className = "subtle";
      why.textContent = `Почему: ${p.rationale}`;
      card.append(why);
    }
    if (p.reason) {
      const r = document.createElement("p");
      r.className = "subtle";
      r.textContent = p.reason;
      card.append(r);
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const btnAccept = document.createElement("button");
    btnAccept.type = "button";
    btnAccept.className = "btn btn-primary btn-sm";
    btnAccept.textContent = "Принять";
    btnAccept.addEventListener("click", () => void settle(snap.root, p, "apply"));

    const btnSkip = document.createElement("button");
    btnSkip.type = "button";
    btnSkip.className = "btn btn-ghost btn-sm";
    btnSkip.textContent = "Отклонить";
    btnSkip.addEventListener("click", () => void settle(snap.root, p, "skip"));

    actions.append(btnAccept, btnSkip);
    card.append(actions);
    list.append(card);
  }
}

async function settle(root: string | null, proposal: ProposalView, action: "apply" | "skip") {
  if (state.busy || !root) return;
  state.busy = true;
  try {
    const res = await callTool<{ text: string }>("panel_settle", {
      root,
      id: proposal.id,
      fingerprint: proposal.fingerprint,
      action,
    });
    showToast(res.text);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
    await refresh();
  } finally {
    state.busy = false;
  }
}

async function loadReport(snap: Snapshot) {
  const sel = $<HTMLSelectElement>("report-select");
  const body = $("report-body");
  const reports = snap.reports || [];
  sel.replaceChildren();
  if (!reports.length || !snap.root) {
    const opt = document.createElement("option");
    opt.textContent = "Отчётов пока нет";
    sel.append(opt);
    body.textContent = "Отчёт появится после первого анализа задачи.";
    return;
  }
  if (!state.selectedReport || !reports.includes(state.selectedReport)) {
    state.selectedReport = reports[0]!;
  }
  for (const file of reports) {
    const opt = document.createElement("option");
    opt.value = file;
    opt.textContent = file;
    if (file === state.selectedReport) opt.selected = true;
    sel.append(opt);
  }
  try {
    const data = await callTool<{ text: string }>("panel_report", {
      root: snap.root,
      file: state.selectedReport,
    });
    body.textContent = data.text;
  } catch (err) {
    body.textContent = `Ошибка загрузки отчёта: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderTools(snap: Snapshot) {
  const grid = $("collection-stats");
  grid.replaceChildren();
  const items: [string, number][] = [
    ["Сессии", snap.collection.sessions],
    ["События хуков", snap.collection.events],
    ["Вызовы модели", snap.collection.modelCallsUpperBound],
    ["Устаревших записей", snap.counts.deprecated],
  ];
  for (const [k, v] of items) {
    const box = document.createElement("div");
    box.className = "kv";
    const s = document.createElement("span");
    s.className = "subtle";
    s.textContent = k;
    const b = document.createElement("strong");
    b.textContent = String(v);
    box.append(s, b);
    grid.append(box);
  }
  const counts = snap.collection.counts || {};
  const breakdown = Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  if (breakdown) {
    const full = document.createElement("div");
    full.className = "subtle";
    full.style.gridColumn = "1 / -1";
    full.textContent = breakdown;
    grid.append(full);
  }

  const root = snap.root || "/path/to/project";
  $("cli-cheatsheet").textContent = [
    `archivist init --root "${root}"`,
    `archivist status`,
    `archivist recall <запрос>`,
    `archivist review`,
    `archivist apply <id|all>`,
    `archivist analysis status|enable|disable|run`,
    `archivist collection`,
    `archivist doctor`,
  ].join("\n");
}

function updateVisibility(snap: Snapshot) {
  const hasRoot = Boolean(snap.root);
  const initialized = hasRoot && snap.initialized;
  $("empty-project").classList.toggle("hidden", hasRoot);
  $("uninitialized-box").classList.toggle("hidden", !hasRoot || initialized);
  for (const name of ["entries", "proposals", "reports", "tools"]) {
    const el = $(`tab-${name}`);
    const show = initialized && state.tab === name;
    el.classList.toggle("hidden", !show);
  }
  if (hasRoot && !initialized && state.tab === "tools") {
    $("uninitialized-box").classList.add("hidden");
    $("tab-tools").classList.remove("hidden");
  }
}

async function applySnapshot(snap: Snapshot) {
  state.snapshot = snap;
  if (!state.root && snap.root) state.root = snap.root;
  if (snap.tab) setActiveTab(snap.tab);

  renderProjects(snap);
  renderStatus(snap);
  updateVisibility(snap);
  if (snap.root && snap.initialized) {
    renderEntries(snap);
    renderProposals(snap);
    if (state.tab === "reports") await loadReport(snap);
  }
  if (snap.root) renderTools(snap);
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const snap = await callTool<Snapshot>("panel_state", {
      ...(state.root ? { root: state.root } : {}),
      ...(state.query ? { q: state.query } : {}),
      ...(state.type ? { type: state.type } : {}),
    });
    await applySnapshot(snap);
  } catch (err) {
    $("analysis-label").textContent = "Нет связи с Archivist MCP";
    $("analysis-sub").textContent = err instanceof Error ? err.message : String(err);
    $("status-dot").className = "dot danger";
  } finally {
    state.refreshing = false;
  }
}

// Register DOM events
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
  btn.addEventListener("click", async () => {
    setActiveTab(btn.dataset.tab || "entries");
    if (state.snapshot) {
      updateVisibility(state.snapshot);
      if (state.tab === "reports" && state.snapshot.initialized) await loadReport(state.snapshot);
    }
  });
});

document.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    state.type = chip.dataset.type || "";
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    void refresh();
  });
});

let searchTimer: number | undefined;
$<HTMLInputElement>("search").addEventListener("input", (e) => {
  state.query = (e.target as HTMLInputElement).value;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void refresh(), 180);
});

$<HTMLSelectElement>("project-select").addEventListener("change", (e) => {
  state.root = (e.target as HTMLSelectElement).value;
  state.selectedReport = "";
  void refresh();
});

$("btn-add-project").addEventListener("click", () => {
  $("project-form").classList.toggle("hidden");
  $<HTMLInputElement>("project-input").focus();
});
$("project-cancel").addEventListener("click", () => $("project-form").classList.add("hidden"));
$<HTMLFormElement>("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("project-input");
  const val = input.value.trim();
  if (!val) return;
  try {
    const res = await callTool<{ root: string }>("panel_project", { root: val });
    state.root = res.root;
    input.value = "";
    $("project-form").classList.add("hidden");
    showToast(`Открыт проект: ${res.root}`);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
});

$("btn-refresh").addEventListener("click", () => void refresh());

$("btn-init").addEventListener("click", async () => {
  if (!state.root) return;
  try {
    const res = await callTool<{ added: number }>("panel_init", { root: state.root });
    showToast(`Инициализировано · команд добавлено: ${res.added}`);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
});

$("btn-toggle-add").addEventListener("click", () => {
  $("add-form").classList.toggle("hidden");
  $<HTMLInputElement>("add-title").focus();
});
$("add-cancel").addEventListener("click", () => $("add-form").classList.add("hidden"));
$<HTMLFormElement>("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.root) return;
  try {
    const res = await callTool<{ text: string }>("panel_add", {
      root: state.root,
      type: $<HTMLSelectElement>("add-type").value,
      title: $<HTMLInputElement>("add-title").value,
      content: $<HTMLTextAreaElement>("add-content").value,
      rationale: $<HTMLTextAreaElement>("add-rationale").value,
      paths: $<HTMLInputElement>("add-paths").value,
    });
    $<HTMLFormElement>("add-form").reset();
    $("add-form").classList.add("hidden");
    showToast(res.text);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
});

$("btn-toggle-analysis").addEventListener("click", async () => {
  if (!state.root || !state.snapshot) return;
  const action = state.snapshot.analysis.enabled ? "disable" : "enable";
  try {
    const res = await callTool<{ text: string }>("panel_analysis", { root: state.root, action });
    showToast(res.text);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
});

$("btn-run-analysis").addEventListener("click", async () => {
  if (!state.root) return;
  try {
    const res = await callTool<{ text: string }>("panel_analysis", { root: state.root, action: "run" });
    showToast(res.text);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
});

$<HTMLSelectElement>("report-select").addEventListener("change", (e) => {
  state.selectedReport = (e.target as HTMLSelectElement).value;
  if (state.snapshot) void loadReport(state.snapshot);
});

async function runMaint(action: "render" | "lint") {
  if (!state.root) return;
  const out = $("maint-output");
  try {
    const res = await callTool<{ text: string; lines?: string[] }>("panel_maintenance", {
      root: state.root,
      action,
    });
    out.classList.remove("hidden");
    out.textContent = [res.text, ...(res.lines || [])].join("\n");
    showToast(res.text);
    await refresh();
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), true);
  }
}
$("btn-render").addEventListener("click", () => void runMaint("render"));
$("btn-lint").addEventListener("click", () => void runMaint("lint"));

// Register MCP App handlers BEFORE connect()
app.ontoolinput = ({ arguments: args }) => {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.root === "string" && a.root.trim()) state.root = a.root.trim();
    if (typeof a.tab === "string") setActiveTab(a.tab);
  }
};

app.ontoolresult = (result) => {
  const data = result.structuredContent as Snapshot | undefined;
  if (data && typeof data === "object" && "counts" in data) {
    void applySnapshot(data);
  } else {
    void refresh();
  }
};

app.onhostcontextchanged = (ctx) => applyHost(ctx);

void (async () => {
  await app.connect();
  applyHost(app.getHostContext());
  if (!state.snapshot) void refresh();
  window.setInterval(() => {
    const activeTag = document.activeElement?.tagName;
    const hasOpenInlineForm = Boolean(document.querySelector(".card .inline-form:not(.hidden)"));
    if (!document.hidden && !hasOpenInlineForm && activeTag !== "INPUT" && activeTag !== "TEXTAREA") {
      void refresh();
    }
  }, 4000);
})();
