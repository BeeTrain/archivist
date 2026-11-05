import { Command, ComposerPill, MenuItem, Panel, Plugin, Style, createKeyed, createLatest, type Context, type MountedSession } from "@opencode/plugin/gui";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { ArchivistRpc, type UiSnapshot } from "./rpc.js";
import { analysisLabel, entryCount, pillLabel, pillTone } from "./ui-state.js";

const css = `
.archivist-panel{height:100%;overflow:auto;padding:20px;color:var(--text-base);font-size:13px;line-height:1.6}
.archivist-panel *{box-sizing:border-box}.archivist-panel h2{font-size:18px;font-weight:600;margin:0}.archivist-panel h3{font-size:14px;font-weight:600;margin:6px 0}
.archivist-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.archivist-subtle{color:var(--text-weak);font-size:12px}.archivist-state{margin:16px 0;padding:12px 14px;background:var(--surface-raised-base);border:1px solid var(--border-weak-base);border-radius:10px}
.archivist-nav{display:flex;gap:4px;border-bottom:1px solid var(--border-weak-base);margin:18px 0 14px;padding-bottom:8px;flex-wrap:wrap}.archivist-nav button{border-radius:6px;padding:6px 10px;color:var(--text-weak);cursor:pointer}.archivist-nav button[aria-selected=true]{color:var(--text-strong);background:var(--surface-raised-base)}
.archivist-search{margin-bottom:16px}.archivist-card{padding:14px 0;border-bottom:1px solid var(--border-weak-base);overflow-wrap:anywhere}.archivist-card p{margin:6px 0;white-space:pre-wrap}.archivist-actions{display:flex;gap:8px;margin-top:12px}.archivist-empty{padding:32px 4px;color:var(--text-weak);text-align:center}.archivist-error{color:var(--text-diff-delete-base);padding:12px 0}.archivist-result{margin-top:8px;white-space:pre-wrap}.archivist-panel button:focus-visible{outline:2px solid var(--border-interactive-base);outline-offset:2px}.archivist-report{font-size:13px;overflow-wrap:anywhere}
`;

export const setupGui = (ctx: Context) => {
  const [snapshot, setSnapshot] = createSignal<UiSnapshot>();
  const [error, setError] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal<"entries" | "review" | "report">("entries");
  const [working, setWorking] = createSignal(false);
  const [version, setVersion] = createSignal(0);
  let refresh = async () => {};
  let activeKey = "";
  const panelKey = `${ctx.id}:main`;
  const open = (session = ctx.sessions.current()) => { if (session) ctx.layout.open(panelKey, session); };

  createKeyed(() => ctx.sessions.current(), (session) => {
    const controller = new AbortController();
    activeKey = `${session.key}\n${session.directory}`;
    const key = activeKey;
    setSnapshot(undefined);
    setError("");
    setQuery("");
    setView("entries");
    setWorking(false);
    let request: AbortController | undefined;
    let received = false;
    let lastResult = "";
    const update = async () => {
      request?.abort();
      request = new AbortController();
      const signal = AbortSignal.any([controller.signal, request.signal, ctx.signal]);
      try {
        const value = await session.server.client.rpc(ArchivistRpc).snapshot({ sessionID: session.id, query: query() }, { location: { directory: session.directory }, signal }) as UiSnapshot;
        if (signal.aborted || activeKey !== key) return;
        if (received && value.result && value.result.id !== lastResult) {
          ctx.toast.show({ title: "Архивист завершил анализ", description: value.result.proposed ? `На ревью: ${value.result.proposed}` : "Новых знаний нет", variant: "success", actions: [{ label: "Открыть", run: () => open(session) }] });
        }
        lastResult = value.result?.id ?? lastResult;
        received = true;
        setSnapshot(value);
        setError("");
      } catch {
        if (!signal.aborted && activeKey === key) setError("Не удалось получить данные. Архивист должен быть подключён к этому проекту, а сервер — доступен.");
      }
    };
    refresh = update;
    void update();
    const timer = setInterval(() => { void update(); }, 2000);
    onCleanup(() => {
      controller.abort();
      request?.abort();
      clearInterval(timer);
      if (activeKey === key) { activeKey = ""; refresh = async () => {}; }
    });
  }, { otherwise: () => { setSnapshot(undefined); setError(""); } });

  const settle = async (session: MountedSession, proposal: UiSnapshot["proposals"][number], action: "apply" | "skip") => {
    if (working()) return;
    const key = `${session.key}\n${session.directory}`;
    setWorking(true);
    try {
      const result = await session.server.client.rpc(ArchivistRpc).settle({ sessionID: session.id, id: proposal.id, fingerprint: proposal.fingerprint, action }, { location: { directory: session.directory }, signal: ctx.signal }) as { text: string };
      if (activeKey === key && !ctx.signal.aborted) {
        ctx.toast.show({ title: result.text, variant: "success" });
        await refresh();
        setVersion((value) => value + 1);
      }
    } catch (err) {
      if (activeKey === key && !ctx.signal.aborted) {
        ctx.toast.show({ title: "Не удалось разобрать предложение", description: err instanceof Error ? err.message : "Обновите очередь и повторите действие.", variant: "error" });
        await refresh();
      }
    } finally { if (activeKey === key) setWorking(false); }
  };

  ctx.add(Style, css);
  ctx.add(Command, { id: "open", title: "Открыть Архивиста", description: "Записи, ревью и фоновый анализ проекта", slash: { name: "archivist-panel" }, run: () => open() });
  ctx.add(MenuItem, (): MenuItem => ({ menu: "session.panel", id: "open", title: "📚 Архивист", description: snapshot() ? entryCount(snapshot()!.counts.entries) : undefined, run: () => open() }));
  ctx.add(ComposerPill, {
    id: "status", order: 20,
    show: (input) => {
      const value = snapshot();
      if (!value || input.session.key !== ctx.sessions.current()?.key) return;
      return { label: `📚 ${error() ? "Архивист · нет связи" : pillLabel(value)}`, title: `Архивист — ${analysisLabel(value)}`, tone: error() ? "danger" : pillTone(value), run: () => open(input.session) };
    },
  });
  ctx.add(Panel, {
    id: "main", region: "side",
    list: (input) => input.open.includes("main") ? [{ id: "main", title: "📚 Архивист", closable: "compact" }] : [],
    render: (props) => {
      const report = createLatest(() => view() === "report" && snapshot() && `${props.session.key}\n${props.session.directory}\n${snapshot()?.lastReport?.id ?? "none"}\n${version()}`, async (_key, signal) => {
        const session = props.session;
        const result = await session.server.client.rpc(ArchivistRpc).report({ sessionID: session.id }, { location: { directory: session.directory }, signal }) as { text: string };
        return { key: `${session.key}\n${session.directory}`, text: result.text };
      });
      return <section class="archivist-panel" aria-label="Архивист">
        <div class="archivist-row"><div><h2>📚 Архивист</h2><div class="archivist-subtle">{snapshot()?.project ?? "Знания проекта"}</div></div><ctx.ui.Button size="small" variant="ghost" onClick={() => { void refresh(); setVersion((value) => value + 1); }}>Обновить</ctx.ui.Button></div>
        <Show when={error()}><p class="archivist-error" role="alert">{error()}</p></Show>
        <Show when={snapshot()} fallback={<p class="archivist-empty">{error() ? "Данные пока недоступны" : "Загрузка знаний…"}</p>}>
          <div class="archivist-state" role="status"><div class="archivist-row"><strong>{analysisLabel(snapshot()!)}</strong><span class="archivist-subtle">{entryCount(snapshot()!.counts.entries)}</span></div>
            <Show when={snapshot()?.analysisEnabled && snapshot()?.analysis.message !== analysisLabel(snapshot()!)}><div class="archivist-subtle">{snapshot()?.analysis.message}</div></Show>
            <Show when={snapshot()?.result?.summary}><div class="archivist-result">{snapshot()?.result?.summary}</div></Show>
          </div>
          <nav class="archivist-nav" role="tablist" aria-label="Разделы Архивиста">
            <button role="tab" aria-selected={view() === "entries"} onClick={() => setView("entries")}>Записи · {snapshot()?.counts.entries}</button>
            <button role="tab" aria-selected={view() === "review"} onClick={() => setView("review")}>Ревью · {snapshot()?.counts.review}</button>
            <button role="tab" aria-selected={view() === "report"} onClick={() => setView("report")}>Последний отчёт</button>
          </nav>
          <Show when={view() === "entries"}>
            <div class="archivist-search"><ctx.ui.TextInput type="search" label="Поиск по знаниям" placeholder="Команда, ловушка или решение…" value={query()} onInput={(value) => { setQuery(value.slice(0, 500)); void refresh(); }} /></div>
            <Show when={snapshot()?.entries.length} fallback={<p class="archivist-empty">{query() ? "Ничего не найдено" : "Сохранённых записей пока нет"}</p>}>
              <For each={snapshot()?.entries}>{(item) => <article class="archivist-card"><div class="archivist-subtle">{{ command: "Команда", gotcha: "Ловушка", decision: "Решение", procedure: "Процедура" }[item.type] ?? item.type} · {item.id}</div><h3>{item.title}</h3><p>{item.content}</p><Show when={item.rationale}><p class="archivist-subtle">{item.rationale}</p></Show></article>}</For>
              <Show when={(snapshot()?.matching ?? 0) > (snapshot()?.entries.length ?? 0)}><p class="archivist-subtle">Показаны первые 500 записей. Уточните поиск.</p></Show>
            </Show>
          </Show>
          <Show when={view() === "review"}>
            <p class="archivist-subtle">Проверьте предложение перед принятием. Решения и удаления отмечены отдельно.</p>
            <For each={snapshot()?.proposals} fallback={<p class="archivist-empty">Предложений на ревью нет</p>}>{(proposal) => <article class="archivist-card"><div class="archivist-subtle">{proposal.kind}{proposal.human ? " · На ваше усмотрение" : " · Предложение анализатора"}</div><h3>{proposal.title}</h3><p>{proposal.content}</p><Show when={proposal.rationale}><p class="archivist-subtle">{proposal.rationale}</p></Show><Show when={proposal.reason}><p class="archivist-subtle">{proposal.reason}</p></Show><div class="archivist-actions"><ctx.ui.Button size="small" disabled={working() || !!error()} onClick={() => { void settle(props.session, proposal, "apply"); }}>Принять</ctx.ui.Button><ctx.ui.Button size="small" variant="ghost" disabled={working() || !!error()} onClick={() => { void settle(props.session, proposal, "skip"); }}>Отклонить</ctx.ui.Button></div></article>}</For>
          </Show>
          <Show when={view() === "report"}>
            <Show when={report.latest?.key === `${props.session.key}\n${props.session.directory}` && !report.error} fallback={<p class="archivist-empty">{report.error ? "Не удалось загрузить отчёт. Нажмите «Обновить»." : "Загрузка отчёта…"}</p>}><div class="archivist-report"><ctx.ui.Markdown text={report.latest?.text ?? ""} /></div></Show>
          </Show>
        </Show>
      </section>;
    },
  });
};

export default Plugin.define({ setup: setupGui });
