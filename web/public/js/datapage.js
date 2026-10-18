import { indexUrl } from './sources.js';

// The /data page: every published index rebuild's report, charted over time, and the
// live build's per-reporter numbers (codexpublicus/stare#101).
//
// It reads idx.stare.pub/reports/index.json (schemas/reports-index.v1.schema.json),
// which index-publish keeps, and the live build's report.json
// (schemas/index-report.v1.schema.json). The charts are inline SVG drawn here; there is
// no chart library. Everything the page needs is in this one module.

export const REPORTS_URL = indexUrl('reports/index.json');
export const MANIFEST_URL = indexUrl('manifest.json');
export const EMPTY_MESSAGE = 'Index reports start with the next rebuild.';

const VERSION = /^v\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const BASE = /^v\/v\d{4}\.\d{2}\.\d{2}(?:\.\d+)?\/$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

const count = (n) => (Number.isFinite(n) && n >= 0 ? n : null);

// The charts, in order: the row key, the title, and how to show a value.
export const CHARTS = [
  { key: 'entries', title: 'Cases indexed', format: (v) => formatCount(v) },
  { key: 'volumes', title: 'Volumes', format: (v) => formatCount(v) },
  { key: 'coverage', title: 'Coverage (entries ÷ cases)', format: (v) => formatPercent(v) },
  { key: 'exceptions', title: 'Exceptions (allow-listed and failed volumes)', format: (v) => formatCount(v) },
];

export function formatCount(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–';
}

// Coverage is a ratio; show enough digits that 99.99% and 100% read apart.
export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '–';
  const pct = ratio * 100;
  return `${pct >= 99.95 && pct < 100 ? pct.toFixed(3) : pct.toFixed(2)}%`;
}

export function coverage(entries, cases) {
  return Number.isFinite(entries) && Number.isFinite(cases) && cases > 0 ? entries / cases : null;
}

// reports/index.json as rows for the charts, oldest first. Takes the format 1 object or
// a bare array of entries, and skips any entry without a version and usable totals.
export function historyFromIndex(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.reports) ? json.reports : null;
  if (!list) return [];
  const rows = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof item.version !== 'string' || !VERSION.test(item.version)) continue;
    const t = item.totals;
    if (!t || typeof t !== 'object') continue;
    const entries = count(t.entries);
    const cases = count(t.cases);
    const volumes = count(t.volumes);
    if (entries === null || cases === null || volumes === null) continue;
    const date = typeof item.generated_at === 'string' ? new Date(item.generated_at) : null;
    rows.push({
      version: item.version,
      generatedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      report: typeof item.report === 'string' ? item.report : `v/${item.version}/report.json`,
      entries,
      cases,
      volumes,
      coverage: coverage(entries, cases),
      exceptions: (count(t.allowed) ?? 0) + (count(t.failed) ?? 0),
    });
  }
  // By generation time, then by version (CalVer sorts by date, then .N).
  return rows.sort((a, b) => (a.generatedAt ?? '').localeCompare(b.generatedAt ?? '')
    || compareVersions(a.version, b.version));
}

function compareVersions(a, b) {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

// What the page shows instead of charts, or null when it has something to chart.
export function emptyState(rows) {
  return Array.isArray(rows) && rows.length > 0 ? null : EMPTY_MESSAGE;
}

// One chart's points: [{version, value}], leaving out rows without a value.
export function seriesFor(rows, key) {
  return rows
    .filter((r) => Number.isFinite(r[key]))
    .map((r) => ({ version: r.version, generatedAt: r.generatedAt, value: r[key] }));
}

// A linear map from [d0, d1] to [r0, r1]. A flat domain maps to the middle of the range.
export function scale([d0, d1], [r0, r1]) {
  if (d1 === d0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

// The SVG geometry of a series in a width × height box with `pad` on every side: each
// point's x and y, the y axis's extent, and the path through the points. One point
// sits in the middle with an empty path; it's drawn as a dot only.
export function linePath(points, { width = 300, height = 120, pad = 8 } = {}) {
  if (!points.length) return { points: [], d: '', min: null, max: null };
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = scale([0, points.length - 1], [pad, width - pad]);
  const y = scale([min, max], [height - pad, pad]);
  const xy = points.map((p, i) => ({ ...p, x: round(x(i)), y: round(y(p.value)) }));
  const d = xy.length > 1 ? xy.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') : '';
  return { points: xy, d, min, max };
}

const round = (n) => Math.round(n * 100) / 100;

// The live report's reporters as table rows, by slug.
export function reporterRows(report) {
  const reporters = report && typeof report === 'object' ? report.reporters : null;
  if (!reporters || typeof reporters !== 'object') return [];
  return Object.keys(reporters)
    .sort()
    .map((slug) => {
      const r = reporters[slug] || {};
      return {
        reporter: slug,
        volumes: count(r.volumes),
        cases: count(r.cases),
        entries: count(r.entries),
        shortfall: count(r.shortfall),
        coverage: coverage(r.entries, r.cases),
      };
    });
}

// The live build's report.json URL: the root manifest's `base`, or else the newest
// report in the history.
export function liveReportUrl(manifest, rows) {
  const base = manifest && typeof manifest === 'object' ? manifest.base : null;
  if (typeof base === 'string' && BASE.test(base)) return indexUrl(`${base}report.json`);
  const last = rows[rows.length - 1];
  return last ? indexUrl(last.report) : null;
}

async function fetchJson(url, fetchFn) {
  try {
    const resp = await fetchFn(url, { cache: 'no-cache' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

const WIDTH = 300;
const HEIGHT = 120;
const PAD = 8;

function chart(doc, rows, { key, title, format }) {
  const fig = el(doc, 'figure', 'data-chart');
  fig.appendChild(el(doc, 'figcaption', 'data-chart-title', title));
  const series = seriesFor(rows, key);
  const geo = linePath(series, { width: WIDTH, height: HEIGHT, pad: PAD });
  const latest = series[series.length - 1];
  fig.appendChild(el(doc, 'p', 'data-chart-latest', latest ? format(latest.value) : '–'));

  const box = svg(doc, 'svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    class: 'data-chart-svg',
    role: 'img',
    'aria-label': `${title}: ${series.map((p) => `${p.version} ${format(p.value)}`).join(', ')}`,
  });
  for (const yLine of [PAD, HEIGHT - PAD]) {
    box.appendChild(svg(doc, 'line', { x1: 0, x2: WIDTH, y1: yLine, y2: yLine, class: 'data-chart-grid' }));
  }
  if (geo.d) box.appendChild(svg(doc, 'path', { d: geo.d, class: 'data-chart-line' }));
  for (const p of geo.points) {
    const dot = svg(doc, 'circle', { cx: p.x, cy: p.y, r: 3, class: 'data-chart-dot' });
    const tip = svg(doc, 'title');
    tip.textContent = `${p.version}: ${format(p.value)}`;
    dot.appendChild(tip);
    box.appendChild(dot);
  }
  // The dashed lines are the series' highest and lowest values, labelled beside them.
  fig.appendChild(el(doc, 'div', 'data-chart-axis data-chart-axis--y', geo.max === null ? '' : `max ${format(geo.max)}`));
  fig.appendChild(box);
  fig.appendChild(el(doc, 'div', 'data-chart-axis data-chart-axis--y', geo.min === null ? '' : `min ${format(geo.min)}`));
  const span = el(doc, 'div', 'data-chart-axis data-chart-axis--x');
  span.appendChild(el(doc, 'span', '', series[0]?.version ?? ''));
  span.appendChild(el(doc, 'span', '', series.length > 1 ? latest.version : ''));
  fig.appendChild(span);
  return fig;
}

function reporterTable(doc, rows) {
  const table = el(doc, 'table', 'data-table');
  const head = el(doc, 'thead');
  const hr = el(doc, 'tr');
  for (const h of ['Reporter', 'Volumes', 'Cases', 'Entries', 'Shortfall', 'Coverage']) {
    hr.appendChild(el(doc, 'th', h === 'Reporter' ? '' : 'num', h));
  }
  head.appendChild(hr);
  table.appendChild(head);
  const body = el(doc, 'tbody');
  for (const r of rows) {
    const tr = el(doc, 'tr', r.shortfall ? 'data-short' : '');
    tr.appendChild(el(doc, 'td', 'data-reporter', r.reporter));
    for (const v of [r.volumes, r.cases, r.entries, r.shortfall]) tr.appendChild(el(doc, 'td', 'num', formatCount(v)));
    tr.appendChild(el(doc, 'td', 'num', formatPercent(r.coverage)));
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

function dateOf(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

// Fills `root` with the page. Resolves to 'empty', 'charts' (no live report) or 'full'.
export async function mountDataPage(root, fetchFn = globalThis.fetch) {
  const doc = root.ownerDocument;
  const index = typeof fetchFn === 'function' ? await fetchJson(REPORTS_URL, fetchFn) : null;
  const rows = historyFromIndex(index);
  const empty = emptyState(rows);
  if (empty) {
    root.replaceChildren(el(doc, 'p', 'data-empty', empty));
    return 'empty';
  }

  const charts = el(doc, 'div', 'data-charts');
  for (const spec of CHARTS) charts.appendChild(chart(doc, rows, spec));
  const live = el(doc, 'section', 'data-live');
  live.appendChild(el(doc, 'h2', '', 'The live index, by reporter'));
  const status = el(doc, 'p', 'data-note', 'Loading the live build’s report…');
  live.appendChild(status);
  root.replaceChildren(
    el(doc, 'p', 'data-summary', `${rows.length} published ${rows.length === 1 ? 'build' : 'builds'}, ${dateOf(rows[0].generatedAt)} to ${dateOf(rows[rows.length - 1].generatedAt)}.`),
    charts,
    live,
  );

  const manifest = await fetchJson(MANIFEST_URL, fetchFn);
  const url = liveReportUrl(manifest, rows);
  const report = url ? await fetchJson(url, fetchFn) : null;
  const table = reporterRows(report);
  if (!table.length) {
    status.textContent = 'The live build’s report couldn’t be loaded.';
    return 'charts';
  }
  const t = report.totals || {};
  status.textContent = `${report.version ?? ''}, built ${dateOf(report.generated_at)}: ${formatCount(t.entries)} entries for ${formatCount(t.cases)} cases in ${formatCount(t.volumes)} volumes (${formatPercent(coverage(t.entries, t.cases))}).`;
  const wrap = el(doc, 'div', 'data-table-wrap');
  wrap.appendChild(reporterTable(doc, table));
  live.appendChild(wrap);
  return 'full';
}
