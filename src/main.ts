import ForceGraph from 'force-graph';
import { Q, SAMPLE_QUERIES, type Beer, type Envelope } from './beergraph';
import { parseWikitext } from './parse.js';
import { MODELS, Sommelier, type ToolEvent } from './sommelier';
import type { InitInfo } from './worker';

// ---------------------------------------------------------------------------
// Worker client: the relate database lives in a dedicated worker (OPFS).

type Env = Envelope & { wallMs: number };
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let onProgress: ((done: number, total: number) => void) | null = null;

worker.onmessage = (e) => {
  const d = e.data;
  if (d.progress != null) { onProgress?.(d.progress, d.total); return; }
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.error) {
    if (d.trap) pill('engine', 'engine crashed, reload the page', 'warn');
    p.reject(new Error(d.error));
  } else p.resolve(d.result);
};

function call<T = any>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, ...extra });
  });
}
const q = (cypher: string, params?: Record<string, unknown>) => call<Env>('exec', { cypher, params });

// ---------------------------------------------------------------------------
// Small DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtMs = (ms?: number) => (ms == null ? '' : ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
const abv = (v: unknown) => (v == null ? '' : `${String(v).replace('.', ',')}%`);
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: number | undefined;
  return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
};
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function pill(key: string, html: string, kind: 'ok' | 'warn' | 'busy' | '' = '') {
  let el = document.getElementById(`pill-${key}`);
  if (!el) {
    el = document.createElement('span');
    el.id = `pill-${key}`;
    $('#status').appendChild(el);
  }
  el.className = `pill ${kind}`;
  el.innerHTML = html;
}

/** "⚡ 3.2 ms · 10 rows" plus a disclosure with the exact Cypher that ran. */
function qmeta(el: HTMLElement, env: Env | null, cypher: string, params?: Record<string, unknown>) {
  if (!env) { el.innerHTML = ''; return; }
  const engineMs = env.elapsed_ms ?? env.wallMs;
  const p = params && Object.keys(params).length ? `\n\n// params\n${JSON.stringify(params)}` : '';
  el.innerHTML = `<span class="ms">${fmtMs(engineMs)}</span> in relate · ${env.rows.length} row${env.rows.length === 1 ? '' : 's'}
    <details><summary>show Cypher</summary><pre>${esc(cypher.replace(/^\n+|\s+$/g, '').replace(/^ {4}/gm, ''))}${esc(p)}</pre></details>`;
}

// ---------------------------------------------------------------------------
// State

const state = {
  beerId: null as number | null,
  onlyBrewed: true,
  drinker: localGet('beergraph-drinker') || 'you',
};

function localGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k: string, v: string | null) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// Tabs

const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs button')];
function showTab(name: string) {
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll<HTMLElement>('.tab')) s.hidden = s.id !== `tab-${name}`;
  history.replaceState(null, '', `${location.search}#${name}`);
  if (name === 'taste') renderTaste();
  if (name === 'data') renderData();
  if (name === 'sommelier') renderMemory();
  if (name === 'recommend' && recGraph) setTimeout(() => sizeGraph(recGraph!, $('#viz-rec')), 0);
  if (name === 'path' && pathGraph) setTimeout(() => sizeGraph(pathGraph!, $('#viz-path')), 0);
}
tabs.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));
window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1);
  if (tabs.some((b) => b.dataset.tab === t && b.getAttribute('aria-selected') !== 'true')) showTab(t);
});

// ---------------------------------------------------------------------------
// Search box with keyboard navigation (shared by the recommend tab and path pickers)

function attachSearch(input: HTMLInputElement, list: HTMLUListElement, pick: (row: any) => void) {
  let rows: any[] = [];
  let active = -1;
  const render = () => {
    list.innerHTML = rows.length
      ? rows.map((r, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}"><span>${esc(r.name)}${r.stillBrewed ? '' : ' <em>(no longer brewed)</em>'}</span><span class="meta">${esc(r.brewery ?? '')}${r.abv != null ? ' · ' + abv(r.abv) : ''}</span></li>`).join('')
      : `<li class="empty">No beers found</li>`;
    list.hidden = false;
  };
  const run = debounce(async () => {
    const text = input.value.trim();
    if (!text) { list.hidden = true; return; }
    // Add a fuzzy variant of every word so typos still match.
    const lucene = text.split(/\s+/).map((w) => w.replace(/[+\-!(){}[\]^"~*?:\\/]/g, '')).filter(Boolean)
      .map((w) => (w.length > 3 ? `(${w}* OR ${w}~)` : `${w}*`)).join(' AND ');
    if (!lucene) return;
    const env = await q(Q.search, { q: lucene });
    rows = env.error ? [] : env.rows;
    active = rows.length ? 0 : -1;
    render();
  }, 120);
  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim() && rows.length) list.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(rows.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[active]) { pick(rows[active]); list.hidden = true; e.preventDefault(); }
    else if (e.key === 'Escape') list.hidden = true;
  });
  list.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest('li[data-i]') as HTMLElement | null;
    if (li) { pick(rows[+li.dataset.i!]); list.hidden = true; e.preventDefault(); }
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));
}

// ---------------------------------------------------------------------------
// Recommend tab

const searchInput = $<HTMLInputElement>('#search');
attachSearch(searchInput, $<HTMLUListElement>('#search-results'), (row) => {
  searchInput.value = row.name;
  selectBeer(row.id);
});
$<HTMLInputElement>('#only-brewed').addEventListener('change', (e) => {
  state.onlyBrewed = (e.target as HTMLInputElement).checked;
  if (state.beerId != null) selectBeer(state.beerId, false);
});

function recList(ol: HTMLElement, rows: any[], opts: { score?: (r: any) => string; why?: (r: any) => string; empty?: string } = {}) {
  ol.innerHTML = rows.length
    ? rows.map((r) => `<li data-id="${r.id}" title="Open ${esc(r.name)}">
        <span class="name">${esc(r.name)}${r.stillBrewed === false ? ' <em>(no longer brewed)</em>' : ''}</span>
        <span class="score">${opts.score ? opts.score(r) : ''}</span>
        <span class="why">${esc(r.brewery ?? '')}${r.abv != null ? ' · ' + abv(r.abv) : ''}${opts.why ? ' · ' + opts.why(r) : ''}</span>
      </li>`).join('')
    : `<li class="empty">${opts.empty ?? 'Nothing found.'}</li>`;
}
document.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('.recs li[data-id]') as HTMLElement | null;
  if (!li || (e.target as HTMLElement).closest('button')) return;
  showTab('recommend');
  selectBeer(+li.dataset.id!);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function selectBeer(id: number, pushViz = true) {
  state.beerId = id;
  const params = { id, onlyBrewed: state.onlyBrewed };
  const [beer, graph, vector, rating] = await Promise.all([
    q(Q.beer, { id }),
    q(Q.similarGraph, params),
    q(Q.similarVector(state.onlyBrewed), { id }),
    q(`MATCH (:Drinker {name: $drinker})-[r:LIKES|DISLIKES]->(:Beer {id: $id}) RETURN type(r) AS verdict`, { drinker: state.drinker, id }),
  ]);
  const b = beer.rows[0];
  if (!b) return;
  searchInput.value = b.name;
  const types = await q(`MATCH (:Beer {id: $id})-[r:HAS_TYPE]->(t) RETURN t.name AS name, r.inferred AS inferred`, { id });
  const verdict = rating.rows[0]?.verdict;
  $('#beer-card').innerHTML = `
    <div>
      <h3>${esc(b.name)}</h3>
      <p class="brewery">${esc(b.brewery ?? 'unknown brewery')}</p>
      <div class="facts-inline">
        ${b.abv != null ? `<span class="tag abv">${abv(b.abv)}</span>` : ''}
        ${types.rows.map((t) => `<span class="tag ${t.inferred ? 'inferred' : 'type'}" title="${t.inferred ? 'inferred from the name' : 'from Wikipedia'}">${esc(t.name)}</span>`).join('')}
        ${b.fermentation ? `<span class="tag ferm">${esc(b.fermentation)}</span>` : ''}
        <span class="tag ${b.stillBrewed ? 'alive' : 'gone'}">${b.stillBrewed ? 'still brewed' : 'no longer brewed'}${b.from ? ` · ${b.from}${b.until ? '–' + b.until : '–'}` : ''}</span>
      </div>
      ${b.breweryDetail ? `<p class="detail">${esc(b.breweryDetail)}</p>` : ''}
    </div>
    <div class="rate" role="group" aria-label="Rate this beer">
      <button data-verdict="like" class="${verdict === 'LIKES' ? 'on-like' : ''}">I like this</button>
      <button data-verdict="dislike" class="${verdict === 'DISLIKES' ? 'on-dislike' : ''}">Not for me</button>
    </div>`;
  $('#beer-card').querySelectorAll<HTMLButtonElement>('.rate button').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const v = btn.dataset.verdict!;
      const already = (v === 'like' && verdict === 'LIKES') || (v === 'dislike' && verdict === 'DISLIKES');
      if (already) await q(Q.unrate, { drinker: state.drinker, id });
      else await q(Q.rate, { drinker: state.drinker, id, verdict: v, at: Date.now() });
      selectBeer(id, false);
    }),
  );

  recList($('#rec-graph'), graph.rows, { score: (r) => r.score.toFixed(1), why: (r) => r.why.join(', ') });
  qmeta($('#qm-graph'), graph, Q.similarGraph, params);
  recList($('#rec-vector'), vector.rows, { score: (r) => r.score.toFixed(3) });
  qmeta($('#qm-vector'), vector, Q.similarVector(state.onlyBrewed), { id });
  if (pushViz) drawNeighbourhood(id, graph.rows);
}

// ---------------------------------------------------------------------------
// Graph visualisation (force-graph on canvas)

interface VNode { id: string; label: string; name: string; beerId?: number; main?: boolean; rec?: boolean; x?: number; y?: number }
interface VLink { source: string; target: string; type: string }

const LABEL_COLOURS: Record<string, () => [string, string]> = {
  Beer: () => [css('--yellow'), css('--ink')],
  Brewery: () => [css('--red'), '#fff'],
  BeerType: () => [css('--blue'), '#fff'],
  AlcoholPercentage: () => [css('--ink'), '#fff'],
  Fermentation: () => ['#ffffff', css('--ink')],
};
const LABEL_NAMES: Record<string, string> = { Beer: 'Beer', Brewery: 'Brewery', BeerType: 'Beer type', AlcoholPercentage: 'Alcohol %', Fermentation: 'Fermentation' };

function legend(el: HTMLElement) {
  el.innerHTML = Object.keys(LABEL_COLOURS).map((k) => `<span style="--c:${LABEL_COLOURS[k]()[0]}">${LABEL_NAMES[k]}</span>`).join('')
    + `<span style="--c:${css('--yellow')}; outline: 3px solid ${css('--red')}; outline-offset: -1px">recommended</span>`;
}

function makeGraph(el: HTMLElement) {
  const g = new ForceGraph<VNode, VLink>(el)
    .backgroundColor('#ffffff')
    .nodeId('id')
    .linkColor(() => 'rgba(17,17,17,0.35)')
    .linkWidth(1.2)
    .nodeRelSize(5)
    .cooldownTicks(120)
    .nodeLabel((n) => `${LABEL_NAMES[n.label] ?? n.label}: ${n.name}`)
    .nodeCanvasObject((n, ctx, scale) => {
      const [fill, text] = (LABEL_COLOURS[n.label] ?? LABEL_COLOURS.Beer)();
      const size = n.main ? 13 : n.label === 'Beer' ? 7 : 10;
      const x = n.x ?? 0, y = n.y ?? 0;
      ctx.fillStyle = fill;
      ctx.strokeStyle = n.rec ? css('--red') : css('--ink');
      ctx.lineWidth = (n.rec ? 3 : 1.5) / Math.max(scale * 0.6, 0.6);
      ctx.beginPath();
      ctx.rect(x - size / 2, y - size / 2, size, size); // Mondrian: squares, not circles
      ctx.fill();
      ctx.stroke();
      const show = n.main || n.label !== 'Beer' || n.rec || scale > 2.2;
      if (!show) return;
      const fs = Math.max(10 / scale, n.main ? 5 : 3.2);
      ctx.font = `${n.main || n.label !== 'Beer' ? 700 : 500} ${fs}px Helvetica Neue, Helvetica, Arial, sans-serif`;
      const label = n.name.length > 28 ? n.name.slice(0, 27) + '…' : n.name;
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x - w / 2 - 1, y + size / 2 + 1, w + 2, fs + 2);
      ctx.fillStyle = css('--ink');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, y + size / 2 + 2);
      void text;
    })
    .nodePointerAreaPaint((n, color, ctx) => {
      const size = n.main ? 13 : n.label === 'Beer' ? 7 : 10;
      ctx.fillStyle = color;
      ctx.fillRect((n.x ?? 0) - size / 2 - 2, (n.y ?? 0) - size / 2 - 2, size + 4, size + 4);
    })
    .onNodeClick((n) => { if (n.beerId != null) selectBeer(n.beerId); });
  g.d3Force('charge')?.strength(-90);
  sizeGraph(g, el);
  new ResizeObserver(() => sizeGraph(g, el)).observe(el);
  return g;
}
function sizeGraph(g: ForceGraph<VNode, VLink>, el: HTMLElement) {
  if (el.clientWidth) g.width(el.clientWidth).height(el.clientHeight);
}

let recGraph: ForceGraph<VNode, VLink> | null = null;
let pathGraph: ForceGraph<VNode, VLink> | null = null;

async function drawNeighbourhood(id: number, recs: any[]) {
  const env = await q(Q.neighbourhood, { id });
  if (env.error || !env.rows.length) return;
  const nodes = new Map<string, VNode>();
  const links: VLink[] = [];
  const recIds = new Set(recs.slice(0, 5).map((r) => r.id));
  const main = `b${id}`;
  nodes.set(main, { id: main, label: 'Beer', name: env.rows[0].bname, beerId: id, main: true });
  for (const r of env.rows) {
    const hub = `${r.xlabel}:${r.xname}`;
    nodes.set(hub, { id: hub, label: r.xlabel, name: r.xname });
    links.push({ source: main, target: hub, type: r.rel });
    for (const o of r.others) {
      const oid = `b${o.id}`;
      if (!nodes.has(oid)) nodes.set(oid, { id: oid, label: 'Beer', name: o.name, beerId: o.id, rec: recIds.has(o.id) });
      links.push({ source: oid, target: hub, type: r.rel });
    }
  }
  // Make sure the top recommendations are drawn even if they fell outside the sample.
  for (const r of recs.slice(0, 5)) {
    const oid = `b${r.id}`;
    if (nodes.has(oid)) continue;
    nodes.set(oid, { id: oid, label: 'Beer', name: r.name, beerId: r.id, rec: true });
    const conn = await q(`MATCH (:Beer {id: $a})-[:HAS_TYPE|BREWED_BY|HAS_FERMENTATION]->(x)<-[r:HAS_TYPE|BREWED_BY|HAS_FERMENTATION]-(:Beer {id: $b})
                          RETURN labels(x)[0] AS l, x.name AS n, type(r) AS t`, { a: id, b: r.id });
    for (const c of conn.rows) {
      const hub = `${c.l}:${c.n}`;
      if (nodes.has(hub)) links.push({ source: oid, target: hub, type: c.t });
    }
  }
  recGraph ??= makeGraph($('#viz-rec'));
  recGraph.graphData({ nodes: [...nodes.values()], links });
  recGraph.onEngineStop(() => recGraph!.zoomToFit(400, 30));
}

// ---------------------------------------------------------------------------
// My taste tab

const drinkerInput = $<HTMLInputElement>('#drinker');
drinkerInput.value = state.drinker;
drinkerInput.addEventListener('change', () => {
  state.drinker = drinkerInput.value.trim() || 'you';
  drinkerInput.value = state.drinker;
  localSet('beergraph-drinker', state.drinker);
  renderTaste();
  sommelier.reset();
  if (state.beerId != null) selectBeer(state.beerId, false);
});

async function renderTaste() {
  const d = { drinker: state.drinker };
  const [ratings, forMe, forMeVec, peers, drinkers] = await Promise.all([
    q(Q.ratings, d), q(Q.forMe, d), q(Q.forMeVector, d), q(Q.peers, d), q(Q.drinkers),
  ]);
  $('#drinker-list').innerHTML = drinkers.rows.map((r) => `<option value="${esc(r.name)}">${r.likes} likes</option>`).join('');
  ratingList($('#ratings'), ratings.rows, 'No ratings yet. Open a beer on the Recommend tab and press “I like this”, or tell the sommelier what you like.');
  const noLikes = 'Like a few beers first.';
  recList($('#rec-forme'), forMe.rows, { score: (r) => String(r.score), why: (r) => 'because of ' + r.because.join(', '), empty: noLikes });
  qmeta($('#qm-forme'), forMe, Q.forMe, d);
  recList($('#rec-formevec'), forMeVec.rows, { score: (r) => r.score.toFixed(3), empty: noLikes });
  qmeta($('#qm-formevec'), forMeVec, Q.forMeVector, d);
  recList($('#rec-peers'), peers.rows, { score: (r) => String(r.score), why: (r) => 'liked by ' + r.because.join(', '), empty: 'No other drinker shares your likes yet. Switch to another name above, like a few of the same beers, and come back.' });
  qmeta($('#qm-peers'), peers, Q.peers, d);
}

function ratingList(el: HTMLElement, rows: any[], empty: string) {
  el.innerHTML = rows.length
    ? rows.map((r) => `<li data-id="${r.id}"><span class="name">${esc(r.name)}</span>
        <span><span class="verdict ${r.verdict}">${r.verdict === 'LIKES' ? 'likes' : 'dislikes'}</span><button class="x" data-unrate="${r.id}" title="Remove rating" aria-label="Remove rating">✕</button></span>
        <span class="why">${esc(r.brewery ?? '')}${r.abv != null ? ' · ' + abv(r.abv) : ''}</span></li>`).join('')
    : `<li class="empty">${empty}</li>`;
  el.querySelectorAll<HTMLButtonElement>('[data-unrate]').forEach((b) =>
    b.addEventListener('click', async () => {
      await q(Q.unrate, { drinker: state.drinker, id: +b.dataset.unrate! });
      renderTaste();
      renderMemory();
    }),
  );
}

// ---------------------------------------------------------------------------
// Path finder

const pathSel: { from: any; to: any } = { from: null, to: null };
for (const side of ['from', 'to'] as const) {
  const input = $<HTMLInputElement>(`#path-${side}`);
  attachSearch(input, input.nextElementSibling as HTMLUListElement, (row) => {
    input.value = row.name;
    pathSel[side] = row;
    findPath();
  });
}

async function findPath() {
  if (!pathSel.from || !pathSel.to) return;
  const params = { from: pathSel.from.id, to: pathSel.to.id };
  const env = await q(Q.path, params);
  qmeta($('#qm-path'), env, Q.path, params);
  const hops: any[] = env.rows[0]?.hops ?? [];
  if (!hops.length) { $('#path-chain').innerHTML = `<span class="error">${esc(env.error ?? 'No path within 10 hops.')}</span>`; return; }
  $('#path-chain').innerHTML = hops.map((h, i) => {
    const [c, on] = (LABEL_COLOURS[h.label] ?? LABEL_COLOURS.Beer)();
    return `${i ? '<span class="link">→</span>' : ''}<span class="hop" style="--c:${c};--on:${on}"><small>${LABEL_NAMES[h.label] ?? h.label}</small>${esc(h.name)}</span>`;
  }).join('');
  const nodes: VNode[] = hops.map((h, i) => ({
    id: `${h.label}:${h.id ?? h.name}`, label: h.label, name: h.name, beerId: h.id ?? undefined, main: i === 0 || i === hops.length - 1,
  }));
  const links: VLink[] = nodes.slice(1).map((n, i) => ({ source: nodes[i].id, target: n.id, type: '' }));
  pathGraph ??= makeGraph($('#viz-path'));
  pathGraph.onNodeClick((n) => { if (n.beerId != null) { showTab('recommend'); selectBeer(n.beerId); } });
  pathGraph.graphData({ nodes, links });
  pathGraph.onEngineStop(() => pathGraph!.zoomToFit(400, 40));
}

// ---------------------------------------------------------------------------
// Cypher console

const cypherBox = $<HTMLTextAreaElement>('#cypher');
$('#samples').innerHTML = SAMPLE_QUERIES.map((s, i) => `<button data-i="${i}">${esc(s.title)}</button>`).join('');
$('#samples').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLButtonElement | null;
  if (!b) return;
  cypherBox.value = SAMPLE_QUERIES[+b.dataset.i!].cypher;
  runConsole();
});
cypherBox.value = SAMPLE_QUERIES[0].cypher;
cypherBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runConsole(); }
});
$('#run').addEventListener('click', runConsole);

function cell(v: any): string {
  if (v == null) return '<span style="opacity:.4">null</span>';
  if (typeof v === 'object' && v.kind === 'node') return `(:${esc(v.labels.join(':'))} ${esc(v.properties.name ?? v.properties.value ?? '')})`;
  if (typeof v === 'object' && v.type === 'FLOAT32' && Array.isArray(v.values)) return `vector[${v.dim}]`;
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(v);
}
async function runConsole() {
  const cypher = cypherBox.value;
  const env = await q(cypher);
  if (env.error) {
    $('#qm-console').innerHTML = '';
    $('#console-out').innerHTML = `<div class="error">${esc(env.error)}</div>`;
    return;
  }
  $('#qm-console').innerHTML = `<span class="ms">${fmtMs(env.elapsed_ms ?? env.wallMs)}</span> in relate · ${env.rows.length} rows`;
  const cols = env.columns;
  $('#console-out').innerHTML = cols.length
    ? `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${env.rows.map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : `<p class="hint">Done. ${esc(JSON.stringify(Object.fromEntries(Object.entries(env.stats ?? {}).filter(([, v]) => v))))}</p>`;
}

// ---------------------------------------------------------------------------
// Data & storage tab

let initInfo: InitInfo;
let lastLoadMs: number | null = null;

async function renderData() {
  const [meta, counts] = await Promise.all([q(Q.meta), q(Q.counts)]);
  const m = meta.rows[0] ?? {};
  $('#dataset').innerHTML = `
    <dt>Source</dt><dd><a href="${esc(m.source)}" target="_blank" rel="noopener">${esc(m.source)}</a></dd>
    <dt>Revision</dt><dd>${esc(m.revision ?? 'n/a')}</dd>
    <dt>Fetched</dt><dd>${esc(m.fetched ? new Date(m.fetched).toLocaleString() : '')}</dd>
    <dt>Beers</dt><dd>${esc(m.beers)}</dd>`;
  $('#engine').innerHTML = `
    <dt>Engine</dt><dd>relate 1.2.0 (WebAssembly, in a dedicated worker)</dd>
    <dt>Storage</dt><dd>${initInfo.persistent ? 'OPFS <code>opfs://beergraph</code>, durable across reloads' : `in memory only (${esc(initInfo.storageError ?? 'OPFS unavailable')})`}</dd>
    <dt>WASM start</dt><dd>${fmtMs(initInfo.wasmMs)}</dd>
    <dt>Open store</dt><dd>${fmtMs(initInfo.openMs)}</dd>
    ${lastLoadMs != null ? `<dt>Import</dt><dd>${fmtMs(lastLoadMs)}</dd>` : ''}`;
  const colour: Record<string, [string, string]> = {
    Beer: [css('--yellow'), css('--ink')], Brewery: [css('--red'), '#fff'], BeerType: [css('--blue'), '#fff'],
    AlcoholPercentage: [css('--ink'), '#fff'],
  };
  $('#counts').innerHTML = counts.rows.map((r) => {
    const [c, on] = colour[r.label] ?? ['#fff', css('--ink')];
    return `<div style="--c:${c};--on:${on}"><b>${r.n.toLocaleString()}</b><span>${esc(r.label)}</span></div>`;
  }).join('');
}

async function importBeers(beers: Beer[], meta: Record<string, unknown>, log: (s: string) => void) {
  onProgress = (done, total) => { pill('data', `importing <b>${done}/${total}</b>`, 'busy'); };
  const res = await call<{ ms: number; counts: any[] }>('import', { beers, meta });
  onProgress = null;
  lastLoadMs = res.ms;
  log(`Imported ${beers.length} beers in ${fmtMs(res.ms)}: ${res.counts.map((c) => `${c.n} ${c.label}`).join(', ')}`);
  await refreshCounts();
}

$('#refresh-wiki').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('#refresh-wiki');
  const logEl = $('#import-log');
  const log = (s: string) => (logEl.textContent += s + '\n');
  btn.disabled = true;
  logEl.textContent = '';
  try {
    log('Fetching wikitext from nl.wikipedia.org…');
    const t = performance.now();
    const res = await fetch('https://nl.wikipedia.org/w/api.php?action=parse&page=Lijst_van_Belgische_bieren&prop=wikitext|revid&format=json&formatversion=2&origin=*');
    const json = await res.json();
    log(`Got ${(json.parse.wikitext.length / 1024).toFixed(0)} KB (revision ${json.parse.revid}) in ${fmtMs(performance.now() - t)}`);
    const t2 = performance.now();
    const { beers } = parseWikitext(json.parse.wikitext);
    log(`Parsed ${beers.length} beers in ${fmtMs(performance.now() - t2)}`);
    await importBeers(beers, {
      source: 'https://nl.wikipedia.org/wiki/Lijst_van_Belgische_bieren', revision: json.parse.revid,
      license: 'CC BY-SA 4.0', fetched: new Date().toISOString(),
    }, log);
    renderData();
  } catch (e) {
    log(`Failed: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#reset-store').addEventListener('click', async () => {
  if (!confirm('Delete the beer graph, all ratings and the agent memory from this browser?')) return;
  await call('reset');
  location.reload();
});

async function refreshCounts() {
  const c = await q(Q.counts);
  const get = (l: string) => c.rows.find((r) => r.label === l)?.n ?? 0;
  pill('data', `<b>${get('Beer').toLocaleString()}</b> beers · <b>${get('Brewery')}</b> breweries · <b>${get('BeerType')}</b> types`, '');
  pill('nodes', `<b>${c.rows.reduce((s, r) => s + r.n, 0).toLocaleString()}</b> nodes`, '');
}

// ---------------------------------------------------------------------------
// Sommelier tab

const sommelier = new Sommelier(q, () => state.drinker);
const keyInput = $<HTMLInputElement>('#api-key');
const rememberKey = $<HTMLInputElement>('#remember-key');
const modelSelect = $<HTMLSelectElement>('#model');
const chatLog = $('#chat-log');
const chatInput = $<HTMLTextAreaElement>('#chat-input');
const chatSend = $<HTMLButtonElement>('#chat-send');
modelSelect.innerHTML = MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
modelSelect.value = localGet('beergraph-model') ?? MODELS[0].id;
modelSelect.addEventListener('change', () => localSet('beergraph-model', modelSelect.value));

const savedKey = localGet('beergraph-anthropic-key');
if (savedKey) { keyInput.value = savedKey; rememberKey.checked = true; }
const applyKey = () => {
  const k = keyInput.value.trim();
  sommelier.setKey(k);
  localSet('beergraph-anthropic-key', rememberKey.checked && k ? k : null);
  chatEmptyState();
};
keyInput.addEventListener('change', applyKey);
rememberKey.addEventListener('change', applyKey);
$('#forget-key').addEventListener('click', () => { keyInput.value = ''; rememberKey.checked = false; applyKey(); });
applyKey();

const STARTERS = [
  'I love Westmalle Tripel and Duvel. What should I try next?',
  'Which trappist beers are there, and which is the strongest?',
  'I can’t stand sour beers. Recommend a nice dark beer for a winter evening.',
  'My favourite beer is no longer brewed: Duvel Groen. What comes closest?',
  'What do you remember about my taste?',
];
$('#starters').innerHTML = STARTERS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
$('#starters').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  chatInput.value = b.textContent ?? '';
  chatInput.focus();
});

function chatEmptyState() {
  if (chatLog.querySelector('.msg')) return;
  chatLog.innerHTML = `<p class="chat-empty">${sommelier.ready
    ? `Ask anything about Belgian beer. The agent looks things up in the graph, and every tool call shows the Cypher it ran and how long relate took. It remembers what you like as <b>${esc(state.drinker)}</b>, even after a reload.`
    : `Paste an Anthropic API key above to start. Without one, everything else in this demo still works: the recommendations are plain graph queries, no LLM involved.`}</p>`;
}

/** Tiny formatter: escape, then **bold** and line breaks. */
function richText(s: string) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function addMsg(cls: string, html: string) {
  chatLog.querySelector('.chat-empty')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

const TOOL_FAM: Record<string, string> = {
  search_beers: 'yellow', recommend_similar: 'blue', get_taste_profile: 'red', remember_preference: 'red', run_cypher: 'blue',
};
function renderTool(div: HTMLElement, ev: ToolEvent) {
  const args = Object.entries(ev.input).filter(([k]) => k !== 'query' || ev.name !== 'run_cypher').map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  div.className = `toolcall ${ev.error ? 'err' : ''}`;
  div.dataset.fam = TOOL_FAM[ev.name] ?? 'blue';
  div.innerHTML = `<span class="tn">${esc(ev.name)}</span>(${esc(args)})
    ${ev.ms != null ? `<span class="ms">${fmtMs(ev.ms)}</span> ${ev.rows ?? 0} rows` : ev.error ? '' : ' …'}
    ${ev.error ? `<div class="error">${esc(ev.error)}</div>` : ''}
    ${ev.cypher ? `<details><summary>Cypher</summary><pre>${esc(ev.cypher.replace(/^ {2,4}/gm, ''))}</pre></details>` : ''}`;
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  if (!sommelier.ready) { keyInput.focus(); return; }
  chatInput.value = '';
  chatSend.disabled = true;
  addMsg('user', esc(text));
  const toolDivs = new Map<ToolEvent, HTMLElement>();
  const status = $('#chat-status');
  const t0 = performance.now();
  try {
    await sommelier.ask(text, modelSelect.value, {
      tool: (ev) => {
        let div = toolDivs.get(ev);
        if (!div) { div = addMsg('', ''); toolDivs.set(ev, div); }
        renderTool(div, ev);
      },
      text: (t) => addMsg('assistant', richText(t)),
      status: (s) => (status.textContent = s),
    });
    const calls = [...toolDivs.keys()];
    const dbMs = calls.reduce((s, c) => s + (c.ms ?? 0), 0);
    status.innerHTML = `${calls.length} graph call${calls.length === 1 ? '' : 's'}, <span class="ms">${fmtMs(dbMs)}</span> in relate, ${((performance.now() - t0) / 1000).toFixed(1)} s in total`;
  } catch (err) {
    status.textContent = '';
    addMsg('error', esc(apiErrorText(err)));
  } finally {
    chatSend.disabled = false;
    renderMemory();
  }
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $<HTMLFormElement>('#chat-form').requestSubmit(); }
});
$('#chat-new').addEventListener('click', () => {
  sommelier.reset();
  chatLog.innerHTML = '';
  $('#chat-status').textContent = '';
  chatEmptyState();
});

function apiErrorText(err: unknown) {
  const e = err as { status?: number; message?: string };
  if (e.status === 401) return 'The API key was rejected (401). Check that it is correct.';
  if (e.status === 429) return 'Rate limited (429). Wait a moment and try again.';
  if (e.status === 529 || e.status === 503) return 'The API is overloaded right now. Try again shortly.';
  return `Request failed: ${e.message ?? String(err)}`;
}

async function renderMemory() {
  $('#mem-drinker').textContent = state.drinker;
  const d = { drinker: state.drinker };
  const [ratings, questions] = await Promise.all([
    q(Q.ratings, d),
    q(`MATCH (:Drinker {name: $drinker})-[:ASKED]->(qq:Question)
       OPTIONAL MATCH (qq)-[:LOOKED_AT]->(b:Beer)
       WITH qq, count(b) AS beers
       RETURN qq.text AS text, qq.at AS at, beers ORDER BY at DESC LIMIT 8`, d),
  ]);
  ratingList($('#mem-ratings'), ratings.rows, 'Nothing yet. Tell the sommelier which beers you like.');
  $('#mem-questions').innerHTML = questions.rows.length
    ? questions.rows.map((r) => `<li style="cursor:default"><span class="name" style="font-weight:600">${esc(r.text)}</span><span class="score">${r.beers} beers</span><span class="why">${new Date(r.at).toLocaleString()}</span></li>`).join('')
    : `<li class="empty">No conversations yet.</li>`;
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  const t0 = performance.now();
  initInfo = await call<InitInfo>('init');
  const storage = initInfo.persistent ? 'OPFS' : 'memory';
  pill('engine', `relate ready in <b>${fmtMs(initInfo.wasmMs + initInfo.openMs)}</b> · ${storage}`, initInfo.persistent ? 'ok' : 'warn');
  if (!initInfo.persistent) {
    pill('storage', 'not persistent: is the demo open in another tab?', 'warn');
  }
  if (!initInfo.beers) {
    pill('data', 'first run: loading beers.json…', 'busy');
    const data = await (await fetch(`${import.meta.env.BASE_URL}beers.json`)).json();
    await importBeers(data.beers, { source: data.source, revision: data.revision, license: data.license, fetched: data.fetched }, (s) => console.info(s));
    pill('first', initInfo.persistent
      ? `first load: imported in <b>${fmtMs(lastLoadMs!)}</b>. Reload to see it open from OPFS.`
      : `imported in <b>${fmtMs(lastLoadMs!)}</b> (memory only)`, 'busy');
  } else {
    await refreshCounts();
    if (initInfo.drinkerRatings) pill('memory', `<b>${initInfo.drinkerRatings}</b> ratings remembered`, '');
  }
  console.info(`beer graph ready in ${fmtMs(performance.now() - t0)}`);
  legend($('#legend-rec'));
  $('#mem-drinker').textContent = state.drinker;

  // Default beer: Westmalle Tripel, a fine place to start.
  const start = await q(Q.search, { q: 'westmalle tripel' });
  if (start.rows[0]) selectBeer(start.rows[0].id);
  const hash = location.hash.slice(1);
  showTab(tabs.some((t) => t.dataset.tab === hash) ? hash : 'recommend');
  chatEmptyState();
}

boot().catch((e) => {
  console.error(e);
  pill('engine', `failed to start: ${esc((e as Error).message)}`, 'warn');
});
