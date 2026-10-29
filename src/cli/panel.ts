import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { basename } from "node:path";
import type { Io } from "../core/io.js";
import { activeEntries, loadState } from "../core/ledger.js";
import { describeOp, listProposals } from "../core/review.js";
import { analysisStatus } from "../adapters/codex/queue.js";

export const panelSnapshot = async (io: Io) => {
  const [state, proposals] = await Promise.all([loadState(io), listProposals(io)]);
  const entries = activeEntries(state.entries).map(({ id, type, title, content }) => ({ id, type, title, content }));
  return {
    project: basename(io.root),
    entries,
    proposals: proposals.map((p) => ({ id: p.id, text: describeOp(p.op), reason: p.reason })),
    counts: { entries: entries.length, review: proposals.length },
    analysis: await analysisStatus(io),
    updatedAt: new Date().toISOString(),
  };
};

const script = `
const project = document.querySelector('#project');
const list = document.querySelector('#list');
const status = document.querySelector('#status');
const search = document.querySelector('#search');
const tabs = [...document.querySelectorAll('[data-view]')];
let snapshot;
let view = 'entries';
function draw() {
  if (!snapshot) return;
  const query = search.value.toLocaleLowerCase();
  const items = snapshot[view];
  const matches = items.filter(item => JSON.stringify(item).toLocaleLowerCase().includes(query));
  list.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = query ? 'Ничего не найдено' : view === 'entries' ? 'Сохранённых записей пока нет' : 'Предложений на ревью нет';
    list.append(empty);
  }
  for (const item of matches) {
    const card = document.createElement('article');
    const title = document.createElement('h2');
    title.textContent = item.title || item.text;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [item.type, item.id].filter(Boolean).join(' · ');
    card.append(meta, title);
    if (item.content || item.reason) {
      const body = document.createElement('p');
      body.textContent = item.content || item.reason;
      card.append(body);
    }
    list.append(card);
  }
  document.querySelector('#review-help').hidden = view !== 'proposals';
  tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.view === view)));
}
tabs.forEach(tab => tab.addEventListener('click', () => { view = tab.dataset.view; draw(); }));
search.addEventListener('input', draw);
async function refresh() {
  try {
    const response = await fetch('./state', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('unavailable');
    snapshot = await response.json();
    project.textContent = snapshot.project;
    document.querySelector('#entries-count').textContent = snapshot.counts.entries;
    document.querySelector('#review-count').textContent = snapshot.counts.review;
    status.textContent = 'Обновлено в ' + new Date(snapshot.updatedAt).toLocaleTimeString('ru-RU') + ' · каждые 3 секунды';
    status.className = '';
    document.querySelector('#analysis').textContent = snapshot.analysis.enabled ? snapshot.analysis.tasks[0]?.message || 'Фоновый анализ включён · ожидание задачи' : 'Фоновый анализ выключен';
    draw();
  } catch {
    status.textContent = 'Нет связи с Archivist. Данные могли устареть. Повторяем подключение…';
    status.className = 'error';
  } finally { setTimeout(refresh, 3000); }
}
refresh();
`;

export const panelHtml = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Archivist</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:light-dark(#f7f8fa,#14171c);color:light-dark(#202938,#e6eaf0)}
*{box-sizing:border-box}body{margin:0;padding:28px;max-width:960px;margin-inline:auto}header{display:flex;align-items:center;gap:12px}h1{font-size:22px;margin:0}header span{color:light-dark(#687486,#9caabd);overflow-wrap:anywhere}nav{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:26px 0 14px}button{font:inherit;cursor:pointer;text-align:left;border:1px solid light-dark(#d8dfe8,#3b4554);background:light-dark(#fff,#1c222c);color:inherit;border-radius:14px;padding:18px}button[aria-pressed=true]{border-color:#728aff;box-shadow:0 0 0 1px #728aff}strong{display:block;font-size:34px;margin-top:8px}input{width:100%;font:inherit;padding:12px 14px;border-radius:10px;border:1px solid light-dark(#d8dfe8,#3b4554);background:light-dark(#fff,#1c222c);color:inherit}#status,.meta,.empty{font-size:13px;color:light-dark(#687486,#9caabd)}#status.error{color:light-dark(#a53620,#ffad93)}article{background:light-dark(#fff,#1c222c);border:1px solid light-dark(#e1e6ed,#303948);border-radius:12px;padding:18px;margin-top:12px;overflow-wrap:anywhere}h2{font-size:16px;line-height:1.5;margin:8px 0}article p{font-size:14px;white-space:pre-wrap;line-height:1.6;margin-bottom:0}.empty{padding:40px 0;text-align:center}#review-help{font-size:13px;line-height:1.6}button:focus-visible,input:focus-visible{outline:3px solid #728aff;outline-offset:3px}@media(max-width:440px){body{padding:16px}button{padding:14px}}
</style></head><body>
<header><h1>📚 Archivist</h1><span id="project"></span></header>
<nav aria-label="Разделы"><button type="button" data-view="entries" aria-pressed="true">Записей<strong id="entries-count">—</strong></button><button type="button" data-view="proposals" aria-pressed="false">На ревью<strong id="review-count">—</strong></button></nav>
<p id="status" role="status">Подключение к проекту…</p>
<p id="analysis" role="status"></p>
<input id="search" type="search" aria-label="Поиск" placeholder="Поиск по записям и предложениям">
<p id="review-help" hidden>Чтобы разобрать предложения, попросите в чате: «Разбери предложения Archivist на ревью». ID предложения указан на карточке.</p>
<main id="list" aria-label="Записи Archivist"></main>
<script>${script}</script></body></html>`;

export const startPanel = async (io: Io) => {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  const hash = createHash("sha256").update(script).digest("base64");
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (req.url !== prefix && req.url !== `${prefix}state`) { res.writeHead(404).end(); return; }
    try {
      if (req.url === prefix) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(panelHtml);
      } else {
        const data = await panelSnapshot(io);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(data));
      }
    } catch {
      res.writeHead(503).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Panel did not start");
  return { server, url: `http://127.0.0.1:${address.port}${prefix}` };
};
