// Other printings and sources (#320): the case sidebar lists the decision's other
// printings (a reporter citation that opens that printing) and the CourtListener records
// of the same decision, from data the reader already reads. Nothing here is a new file.
//
// - The case's own citations (`citations` in its JSON: CAP's list, or a CourtListener
//   record's), each looked up in its volume's index like a typed citation. The citation of
//   the printing shown, or one that opens it (an alias), is left out, and so is a CAP case's
//   `official` citation, which CAP gives the volume it scanned the case in: br/358/0846-01's
//   reads "358 F. App'x 846", which is another case.
// - The index lines at the case's own page: an alias there to a case in another volume,
//   `via=cl:<cluster>`, is CourtListener's citation metadata filing this page's citation
//   under that case too, so that case is another printing and the cluster a record of the
//   decision. Only on a page one CAP case starts on, since the line doesn't say which case
//   of a shared page it's for. These are labelled as coming from CourtListener's metadata.
// - The minted-key ledger's decision row, for a case opened from `/k/<key>/` or `/d/<id>/`
//   (D208): its `cap:` printings and `cl-cluster:` records, and those of any decision
//   merged into it. A case opened by its hash has no row: nothing published maps a case
//   file to its key.
//
// The ledger doesn't say which printing is official, so the list keeps the order it found
// them in (the case's citations, then the index's aliases, then the ledger's) and calls
// none of them official. A CourtListener record that stare.pub opens at a citation links
// there; one it has no address for (a record the ledger joined to a CAP decision opens
// that decision's CAP printing, D208) links to CourtListener.
//
// The lookups run after the case is shown, from the index files' cache (cache.js's `bins`):
// a citation in a volume not yet read costs that volume's index file, 0.4 to 5 KB.

import { capSource, clusters as clusterSources } from './caseaddress.js';
import { isClRecord } from './cl.js';
import { idxEntries } from './idx.js';
import { foldedInto, hasAliasVolume, hasIdx, holdsVolume, loadManifest } from './manifest.js';
import { filePage, pageSegment } from './pagekey.js';
import { parseInput } from './resolve.js';
import { caseHash } from './router.js';

export const COURTLISTENER_OPINION = 'https://www.courtlistener.com/opinion/';

const seqOf = (file) => parseInt(String(file).slice(String(file).lastIndexOf('-') + 1), 10) || 1;
const capId = (t) => `cap:${t.reporter}/${t.folder}/${t.file}`;
const sameCase = (a, b) => !!a && !!b && !!a.file && a.reporter === b.reporter
  && String(a.folder) === String(b.folder) && a.file === b.file;

/**
 * The printing a resolved case shows (main.js's `result`): `{ reporter, folder, file, page,
 * cluster }`, with `file` the CAP case file (null for a CourtListener record) and `cluster`
 * the record's CourtListener cluster (null for a CAP case).
 */
export function shownOf(result) {
  if (isClRecord(result?.caseData)) {
    const cluster = Number(result.caseData.source?.ids?.cluster);
    return {
      reporter: result.reporter || null, folder: result.volume || null, file: null,
      page: result.page ?? null, cluster: Number.isSafeInteger(cluster) ? cluster : null,
    };
  }
  return {
    reporter: result.reporter, folder: String(result.volume), file: result.caseFile,
    page: filePage(result.caseFile), cluster: null,
  };
}

/**
 * A ledger decision row (`{ sources, merged }`, `merged` the rows of decisions merged into
 * it) as `{ printings, clusters }`: its CAP printings as `{ reporter, folder, file }` and its
 * CourtListener clusters as numbers, in the row's order, the merged rows' after. Null for
 * none.
 */
export function ledgerSources(row) {
  if (!row || !Array.isArray(row.sources)) return null;
  const sources = [...row.sources, ...(row.merged || []).flatMap((d) => d?.sources || [])];
  const printings = sources.map(capSource).filter(Boolean)
    .map((p) => ({ reporter: p.reporter, folder: p.volume, file: p.file }));
  return { printings, clusters: clusterSources(sources) };
}

/**
 * What a citation opens, from the index entries at its page (idx.js's, null or [] for none):
 * `{ kind: 'self' }` for the printing shown or a citation that opens it; `{ kind: 'cap',
 * targets, via }`, the CAP cases that start there (the alias's one case, with its `via`);
 * `{ kind: 'cl', records }`, CourtListener's records there; or `{ kind: 'missing', reason }`,
 * 'volume' when the index doesn't hold the volume and 'page' when no case starts there.
 * `cited` is `{ reporter, volume, page }`.
 */
export function classifyEntries(entries, cited, shown, held = true) {
  if (!held) return { kind: 'missing', reason: 'volume' };
  if (!entries || entries.length === 0) return { kind: 'missing', reason: 'page' };
  const first = entries[0];
  if (first.source === 'cap' && first.reporter) {
    const target = { reporter: first.reporter, folder: first.folder, file: first.case_file };
    return sameCase(target, shown) ? { kind: 'self' } : { kind: 'cap', targets: [target], via: first.via || null };
  }
  if (first.source === 'cap') {
    const folder = first.folder || String(cited.volume);
    const targets = entries
      .filter((e) => e.source === 'cap' && !e.reporter && (e.folder || null) === (first.folder || null))
      .map((e) => ({ reporter: cited.reporter, folder, file: e.case_file }));
    return targets.some((t) => sameCase(t, shown)) ? { kind: 'self' } : { kind: 'cap', targets, via: null };
  }
  const records = entries.filter((e) => e.source === 'cl');
  if (shown.cluster && records.some((r) => r.cluster_id === shown.cluster)) return { kind: 'self' };
  return records.length ? { kind: 'cl', records } : { kind: 'missing', reason: 'page' };
}

/**
 * The aliases at the shown case's own page that name a case in another volume through
 * CourtListener's citation metadata, as `{ target, cluster }`; none when more than one CAP
 * case starts on the page, since the line doesn't say which it's for.
 */
export function pageAliases(entries, shown) {
  if (!shown.file || !Array.isArray(entries)) return [];
  const own = entries.filter((e) => e.source === 'cap' && !e.reporter);
  if (own.length !== 1) return [];
  return entries
    .filter((e) => e.source === 'cap' && e.reporter && /^cl:\d+$/.test(e.via || ''))
    .map((e) => ({
      target: { reporter: e.reporter, folder: e.folder, file: e.case_file },
      cluster: Number(e.via.slice(3)),
    }))
    .filter((a) => !(a.target.reporter === shown.reporter && String(a.target.folder) === String(shown.folder)));
}

const VIA_NOTE = "Listed through CourtListener's citation metadata";
const LEDGER_NOTE = "The key ledger doesn't list this case as a printing of the decision";

/**
 * The list's rows, deduplicated, in the order found: `{ label, source, href, external,
 * note }`. `source` is 'cap' (a CAP case file), 'cl' (a CourtListener record), 'none' (a
 * printing stare.pub doesn't hold) or 'unknown' (a citation that couldn't be checked);
 * `href` is the reader's hash for the printing, CourtListener's page for a record the reader
 * has no address for, or null. `cites` are `{ text, cited, outcome }` (outcome:
 * classifyEntries's, `{ kind: 'unparsed' }` or `{ kind: 'error' }`), `aliases` pageAliases's
 * and `ledger` ledgerSources's.
 */
export function buildRows({ cites = [], aliases = [], ledger = null, shown }) {
  const rows = [];
  const byKey = new Map();
  // The CAP cases the decision is known to be printed as: a page several cases start on
  // opens the one of them these name.
  const known = new Set([...aliases.map((a) => capId(a.target)), ...(ledger?.printings || []).map(capId)]);

  const add = (keys, row, viaOnly = false) => {
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (hit) {
      // Named again by something other than CourtListener's metadata: no longer only that.
      if (!viaOnly && hit.note === VIA_NOTE) hit.note = row.note ?? null;
      keys.forEach((k) => byKey.set(k, hit));
      return;
    }
    const r = { label: row.label, source: row.source, href: row.href ?? null, external: !!row.external, note: row.note ?? null };
    rows.push(r);
    keys.forEach((k) => byKey.set(k, r));
  };
  const capRow = (t, label, viaOnly, note = null) => {
    if (sameCase(t, shown)) return;
    const page = filePage(t.file);
    add([capId(t)], {
      label: label || `${t.reporter} ${t.folder} ${page}`,
      source: 'cap',
      href: caseHash(t.reporter, t.folder, page, seqOf(t.file)),
      note: note || (viaOnly ? VIA_NOTE : null),
    }, viaOnly);
  };
  const clusterRow = (cluster, viaOnly) => {
    if (!Number.isSafeInteger(cluster) || cluster === shown.cluster) return;
    add([`cl:${cluster}`], {
      label: `Opinion cluster ${cluster}`,
      source: 'cl',
      href: `${COURTLISTENER_OPINION}${cluster}/`,
      external: true,
      note: viaOnly ? VIA_NOTE : "CourtListener's page; stare.pub has no address that opens this record",
    }, viaOnly);
  };

  for (const { text, cited, outcome } of cites) {
    const citeKey = cited ? `cite:${cited.reporter}/${cited.volume}/${cited.page}` : `text:${text}`;
    switch (outcome?.kind) {
      case 'self':
        break;
      case 'cap': {
        const viaOnly = /^cl:/.test(outcome.via || '');
        const pick = outcome.targets.length === 1
          ? outcome.targets[0]
          : outcome.targets.find((t) => known.has(capId(t)));
        if (pick) {
          const unlisted = ledger && !ledger.printings.some((p) => capId(p) === capId(pick));
          capRow(pick, text, viaOnly, unlisted ? LEDGER_NOTE : null);
          if (byKey.has(capId(pick))) byKey.set(citeKey, byKey.get(capId(pick)));
        } else {
          add([citeKey], {
            label: text,
            source: 'cap',
            href: `#${cited.reporter}/${outcome.targets[0].folder}/${pageSegment(cited.page)}`,
            note: `One of the ${outcome.targets.length} cases that start on that page`,
          });
        }
        break;
      }
      case 'cl': {
        const n = outcome.records.length;
        add([citeKey, ...outcome.records.map((r) => `cl:${r.cluster_id}`)], {
          label: text,
          source: 'cl',
          href: `#${cited.reporter}/${cited.volume}/${pageSegment(cited.page)}`,
          note: n > 1 ? `${n} CourtListener records start on that page` : null,
        });
        break;
      }
      case 'missing':
        add([citeKey], {
          label: text,
          source: 'none',
          note: outcome.reason === 'volume'
            ? "stare.pub doesn't hold this volume"
            : 'No case starts at this page in the index',
        });
        break;
      case 'unparsed':
        add([citeKey], { label: text, source: 'none', note: "stare.pub couldn't read this citation" });
        break;
      default:
        add([citeKey], { label: text, source: 'unknown', note: "Couldn't check the index for this citation" });
    }
  }
  for (const a of aliases) capRow(a.target, null, true);
  for (const p of ledger?.printings || []) capRow(p, null, false);
  for (const a of aliases) clusterRow(a.cluster, true);
  for (const c of ledger?.clusters || []) clusterRow(c, false);
  return rows;
}

/** The citations in a case's JSON to look up: a CAP case's `official` one is its own. */
export function citationsToCheck(caseData, shown) {
  return (caseData?.citations || []).filter((c) => !(shown.file && c?.type === 'official'));
}

/**
 * How many rows to hold room for before the lookups finish, so filling the list moves
 * nothing below it: one for each citation but the case's own, plus what the aliases at its
 * page (when the result has them) and the ledger name; 0 when there's nothing to look up.
 */
export function estimateRows(caseData, shown, { aliases = null, ledger = null } = {}) {
  const checked = citationsToCheck(caseData, shown).length;
  // A CourtListener record's citations include its own.
  const others = shown.file ? checked : Math.max(0, checked - 1);
  const known = buildRows({ aliases: aliases || [], ledger, shown });
  // A citation usually opens one of the CAP printings the aliases and the ledger name, so
  // those are counted once.
  const cap = known.filter((r) => r.source === 'cap').length;
  const rows = Math.max(others, cap) + known.length - cap;
  const pendingAliases = shown.file && aliases === null ? 1 : 0;
  return Math.max(rows, pendingAliases);
}

// The entries at a page as cited, or null when the index can't be read for it: `held` is
// false for a volume the index doesn't hold (no fetch is made for it).
async function entriesAt(reporter, volume, page) {
  const manifest = await loadManifest();
  if (!hasIdx(manifest)) return null;
  const cited = String(volume);
  const number = foldedInto(manifest, reporter, cited);
  if (!number && !holdsVolume(manifest, reporter, cited) && !hasAliasVolume(manifest, reporter, cited)) {
    return { held: false, entries: [] };
  }
  let entries = await idxEntries(reporter, number || cited, page);
  if (entries && number) entries = entries.filter((e) => e.source === 'cap' && !e.reporter && e.folder === cited);
  return entries ? { held: true, entries } : null;
}

// A citation's text as `{ reporter, volume, page }` through the reader's parser, or null.
async function parseCite(text) {
  const p = await parseInput(text);
  return p ? { reporter: p.reporter, volume: String(p.volume), page: p.page } : null;
}

const found = new Map();

/**
 * findAltSources, once a page for each case and ledger row; a lookup that failed in part is
 * tried again the next time.
 */
export function altSourcesFor(result, ledger = null) {
  const shown = shownOf(result);
  const key = `${shown.file ? capId(shown) : `cl:${shown.cluster}`}|${ledger ? 'ledger' : ''}`;
  if (!found.has(key)) {
    const p = findAltSources(result, ledger);
    found.set(key, p);
    p.then((r) => { if (r.incomplete) found.delete(key); }, () => found.delete(key));
  }
  return found.get(key);
}

/**
 * The rows for a resolved case, `{ rows, incomplete }`: buildRows's, and whether a lookup
 * failed (a citation's row then says "Not checked"; the page's own aliases have no row to
 * say it on). `ledger` is the decision row the address opened (`{ sources, merged }`), or
 * null. The result's `pageEntries`, the index entries at
 * its page when it was opened there, saves looking them up again. `deps` ({ parse,
 * entriesAt }) replace the parser and the index in tests; `entriesAt(reporter, volume,
 * page)` returns `{ held, entries }` or null.
 */
export async function findAltSources(result, ledger = null, deps = {}) {
  const parse = deps.parse || parseCite;
  const lookup = deps.entriesAt || entriesAt;
  const shown = shownOf(result);
  const cites = await Promise.all(citationsToCheck(result.caseData, shown).map(async (c) => {
    const text = String(c?.cite || '').trim();
    if (!text) return null;
    let cited;
    try {
      cited = await parse(text);
    } catch {
      return { text, cited: null, outcome: { kind: 'error' } };
    }
    if (!cited) return { text, cited: null, outcome: { kind: 'unparsed' } };
    try {
      const at = await lookup(cited.reporter, cited.volume, cited.page);
      if (!at) return { text, cited, outcome: { kind: 'error' } };
      return { text, cited, outcome: classifyEntries(at.entries, cited, shown, at.held) };
    } catch {
      return { text, cited, outcome: { kind: 'error' } };
    }
  }));
  let aliases = [];
  let aliasesFailed = false;
  if (shown.file) {
    let entries = result.pageEntries || null;
    if (!entries) {
      try {
        const at = await lookup(shown.reporter, shown.folder, shown.page);
        entries = at?.entries || null;
        aliasesFailed = !at;
      } catch {
        aliasesFailed = true;
      }
    }
    aliases = pageAliases(entries, shown);
  }
  const rows = buildRows({ cites: cites.filter(Boolean), aliases, ledger: ledgerSources(ledger), shown });
  return { rows, incomplete: aliasesFailed || rows.some((r) => r.source === 'unknown'), aliasesFailed };
}

const SOURCE_LABEL = {
  cap: 'CAP',
  cl: 'CourtListener',
  none: 'Not on stare.pub',
  unknown: 'Not checked',
};
const SOURCE_TITLE = {
  cap: 'Caselaw Access Project',
  cl: 'CourtListener',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** One row's list item. */
export function rowHtml(row) {
  const title = row.note ? ` title="${esc(row.note)}"` : '';
  const label = row.href
    ? `<a class="alt-link" href="${esc(row.href)}"${row.external ? ' target="_blank" rel="noopener"' : ''}${title}>${esc(row.label)}</a>`
    : `<span class="alt-text"${title}>${esc(row.label)}</span>`;
  const sourceTitle = SOURCE_TITLE[row.source] ? ` title="${esc(SOURCE_TITLE[row.source])}"` : '';
  return `<li class="alt-item alt-${row.source}">${label} <span class="alt-source"${sourceTitle}>${esc(SOURCE_LABEL[row.source] || '')}</span></li>`;
}

export const ALT_LABEL = 'Other printings and sources';
export const ALT_CHECKING = 'Checking the index...';
export const ALT_NONE = 'None found in the index.';
export const ALT_FAILED = "Couldn't check the index for other printings.";

/**
 * Sets up the section `el` (renderSidebar's `#alt-sources`) for `rows` rows to come: its
 * label and a "Checking" line, with room held for the rows. With 0 rows it's removed, since
 * there's nothing to look up. Runs before the sidebar is painted, so this moves nothing.
 */
export function reserveAltSources(el, rows) {
  if (!el) return null;
  if (rows <= 0) {
    el.remove();
    return null;
  }
  el.innerHTML = `<div class="sidebar-label">${ALT_LABEL}</div>`
    + `<div class="alt-body"><p class="alt-status">${ALT_CHECKING}</p><ul class="alt-list"></ul></div>`;
  el.querySelector('.alt-body').style.setProperty('--alt-rows', String(rows));
  return el;
}

export const ALT_PARTIAL = "Couldn't check the index at this page.";

/**
 * Fills the section from findAltSources's `found`: its rows, "None found" for none, and a
 * failure line when the lookups failed (`found` null) or the page's own lookup did. The
 * room reserveAltSources held stays, so a shorter list moves nothing.
 */
export function fillAltSources(el, found) {
  if (!el?.isConnected) return;
  const status = el.querySelector('.alt-status');
  const list = el.querySelector('.alt-list');
  if (!status || !list) return;
  const rows = found?.rows || [];
  list.innerHTML = rows.map(rowHtml).join('');
  let text = '';
  if (!found) text = ALT_FAILED;
  else if (found.aliasesFailed) text = rows.length ? ALT_PARTIAL : ALT_FAILED;
  else if (!rows.length) text = ALT_NONE;
  status.textContent = text;
  status.classList.toggle('alt-error', !found || !!found.aliasesFailed);
  status.classList.toggle('hidden', !text);
}
