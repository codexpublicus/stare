// Permanent case addresses (D99, D121, D147): `/k/<key>/`, a decision's CRK key, and
// `/c/<jurisdiction>/<slug>/<volume>/<page>/`, a citation lookup (D97, D89, D59's `/<n>/`
// for a page several cases officially share). Neither is a file: Cloudflare serves the
// reader for a browser navigation to a path no file matches (wrangler.jsonc's
// single-page-application fallback), and the reader reads the address here.
//
// A key resolves from the minted-key ledger on data.stare.pub (`crk/ledger/`): its
// latest.json names each court's shards, the key's shard is
// `courts[court][fnv1a32(stem) % courts[court].length]`, and the shard holds the key's row
// and its decision's row, whose `cap:` sources are the case files the reader opens. A
// `/c/` address resolves through the per-volume index like a typed citation, so nothing
// here fetches for it.

import { DATA_URL } from './sources.js';
import { fetchCached, gunzip } from './cache.js';
import { filePage } from './pagekey.js';
import { isVolumeKey } from './manifest.js';
import { parseDecisionPath } from './decisionroute.js';

export const LEDGER_URL = `${DATA_URL}/crk/ledger`;

// One key segment: what exemplar's keys are made of (`rpt.500-pa-524`, `1983-04-27~2`).
const KEY_SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/;
// A slug or jurisdiction code: lowercase letters, digits and hyphens.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function decodeSegments(rest) {
  const parts = rest.split('/');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

/**
 * What a path names: `{ kind: 'k', key }` for `/k/<key>/`, `{ kind: 'c', jurisdiction,
 * reporter, volume, page, n }` for `/c/<jurisdiction>/<slug>/<volume>/<page>/[<n>/]`,
 * `{ kind: 'bad', prefix }` for a `/k/` or `/c/` path that names nothing, and null for any
 * other path (the reader's own `/` among them). Keys are lowercase; a path in capitals reads
 * as its lowercase form. `/d/<id>/` is decisionroute.js's: `{ kind: 'd', id }`, or
 * `{ kind: 'bad', prefix: 'd' }`.
 */
export function parseCasePath(pathname) {
  const path = String(pathname || '');
  const decision = parseDecisionPath(path);
  if (decision) return decision;
  const m = path.match(/^\/([kc])\/(.*)$/);
  if (!m) return null;
  const segs = decodeSegments(m[2]);
  const bad = { kind: 'bad', prefix: m[1] };
  if (!segs || segs.some((s) => s === '')) return bad;
  if (m[1] === 'k') {
    // A key has a court (two segments: jurisdiction and court), then at least a stem
    // segment: `us/dc/69/1943-05-11`.
    const key = segs.join('/').toLowerCase();
    if (segs.length < 3 || !segs.every((s) => KEY_SEGMENT.test(s.toLowerCase()))) return bad;
    return { kind: 'k', key };
  }
  if (segs.length !== 4 && segs.length !== 5) return bad;
  const [jurisdiction, reporter, volume, pageText, nText] = segs.map((s) => s.toLowerCase());
  if (!SLUG.test(jurisdiction) || !SLUG.test(reporter) || !isVolumeKey(volume)) return bad;
  const page = /^\d+$/.test(pageText) ? Number(pageText) : null;
  if (page === null || !Number.isSafeInteger(page)) return bad;
  let n = null;
  if (nText !== undefined) {
    if (!/^[1-9]\d{0,3}$/.test(nText)) return bad;
    n = Number(nText);
  }
  return { kind: 'c', jurisdiction, reporter, volume, page, n };
}

/** The path for a key: `/k/us/dc/69/1943-05-11/`. */
export function keyPath(key) {
  return `/k/${String(key).split('/').map(encodeURIComponent).join('/')}/`;
}

/** The path for a citation: `/c/us/a2d/31/647/`, with `/<n>/` for the nth case on a shared page. */
export function citationPath(jurisdiction, reporter, volume, page, n = null) {
  return `/c/${jurisdiction}/${reporter}/${volume}/${page}/${n ? `${n}/` : ''}`;
}

/** FNV-1a 32 of a string's UTF-8 bytes, as the ledger buckets stems. */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A key's court (`us/dc`) and stem (the key without `~n`). */
export function keyParts(key) {
  const segs = String(key).split('/');
  return { court: segs.slice(0, 2).join('/'), stem: String(key).replace(/~\d+$/, '') };
}

/**
 * The shard path (`s/<hash>.json.gz`) that holds `key` in a ledger's latest.json (or a
 * version's index.json), or null when the court has no keys or the key's bucket is empty.
 */
export function shardFor(ledger, key) {
  const { court, stem } = keyParts(key);
  const shards = ledger?.courts?.[court];
  if (!Array.isArray(shards) || shards.length === 0) return null;
  const hash = shards[fnv1a32(stem) % shards.length];
  if (!hash) return null;
  const pattern = typeof ledger.shard_path === 'string' ? ledger.shard_path : 's/{hash}.json.gz';
  return pattern.replace('{hash}', hash);
}

// The West regional and national reporters: a decision printed in one and in its court's
// own reports opens on the court's own (D124 (6): the official reporter's text). The
// ledger doesn't say which printing is official, so this is the reader's best guess.
const REGIONAL = new Set([
  'a', 'a2d', 'a3d', 'p', 'p2d', 'p3d', 'ne', 'ne2d', 'ne3d', 'nw', 'nw2d', 'se', 'se2d',
  'so', 'so2d', 'so3d', 'sw', 'sw2d', 'sw3d', 'nys', 'nys2d', 'nys3d', 'cal-rptr',
  'cal-rptr-2d', 'cal-rptr-3d', 'ill-dec', 's-ct', 'l-ed', 'l-ed-2d',
]);

/** A `cap:<slug>/<folder>/<case file>` source as `{ reporter, volume, page, seq, file }`, or null. */
export function capSource(source) {
  const m = String(source).match(/^cap:([a-z0-9-]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const [, reporter, volume, file] = m;
  const page = filePage(file);
  if (page === null || page === undefined) return null;
  const seq = parseInt(file.slice(file.lastIndexOf('-') + 1), 10) || 1;
  return { reporter, volume, page, seq, file };
}

/**
 * The CAP printing a decision opens on, from its row's `sources`, or null when it has
 * none: the printing a `rpt.<volume>-<slug>-<page>` key segment names, else the first in
 * the court's own reports, else the first.
 */
export function pickPrinting(sources, key = '') {
  const printings = (sources || []).map(capSource).filter(Boolean);
  if (!printings.length) return null;
  const segs = String(key).split('/');
  const named = printings.find((p) => {
    const number = p.volume.replace(/-\d+$/, '');
    return segs.includes(`rpt.${number}-${p.reporter}-${p.page}`);
  });
  return named || printings.find((p) => !REGIONAL.has(p.reporter)) || printings[0];
}

/** The CourtListener clusters among a decision's sources, as numbers. */
export function clusters(sources) {
  return (sources || []).map((s) => String(s).match(/^cl-cluster:(\d+)$/)?.[1]).filter(Boolean).map(Number);
}

/**
 * What a key resolves to in one shard's rows (`{ keys, decisions }`):
 * `{ found: false }` when stare.pub hasn't minted it; otherwise `{ found: true, key, current,
 * provisional, decision, replaced }`: `current` is the key that names the decision now (the
 * row's `current` for a replaced key, the key itself otherwise), `replaced` whether the two
 * differ, and `decision` the decision row (null if the shard lacks it). A replaced key's
 * `current` is in the same court as a rule, but not always (a replacement in another court),
 * so the decision is looked up by id, which the shard holds either way.
 */
export function resolveInShard(shard, key) {
  const row = (shard?.keys || []).find((r) => r.key === key);
  if (!row) return { found: false };
  const current = row.status === 'active' ? key : (row.current || row.replaced_by || key);
  const decisions = shard.decisions || [];
  let decision = decisions.find((d) => d.id === row.id) || null;
  // A duplicate merged into another decision is that decision from then on.
  for (let i = 0; decision?.merged_into && i < 8; i += 1) {
    const into = decision.merged_into;
    decision = decisions.find((d) => d.id === into) || decision;
    if (decision.id !== into) break;
  }
  return {
    found: true,
    key,
    current,
    replaced: current !== key,
    status: row.status,
    provisional: decision ? !!decision.provisional : !!row.provisional,
    decision,
  };
}

let ledgerPromise = null;

/** latest.json, fetched once a page (it's cached for a minute on the wire). */
export function loadLedger(fetchFn = globalThis.fetch) {
  if (!ledgerPromise) {
    ledgerPromise = (async () => {
      const resp = await fetchFn(`${LEDGER_URL}/latest.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching the key ledger`);
      return resp.json();
    })();
    ledgerPromise.catch(() => { ledgerPromise = null; });
  }
  return ledgerPromise;
}

/** For tests: forget the ledger fetched. */
export function resetLedger() {
  ledgerPromise = null;
}

// A shard is content-addressed and immutable, so it's kept in the browser cache with the
// index files (cache.js's `bins` store, under a key no index prune matches).
async function loadShard(path) {
  const bytes = await fetchCached('bins', `crk/ledger/${path}`, `${LEDGER_URL}/${path}`);
  return JSON.parse(new TextDecoder().decode(await gunzip(bytes)));
}

/**
 * Resolves `key` from the ledger: resolveInShard's result, with the current key's own
 * shard read when a replacement is in another court. `deps` replaces the fetches in tests.
 */
export async function resolveKey(key, deps = {}) {
  const ledger = await (deps.loadLedger || loadLedger)();
  const shardOf = deps.loadShard || loadShard;
  const path = shardFor(ledger, key);
  if (!path) return { found: false };
  const hit = resolveInShard(await shardOf(path), key);
  if (!hit.found || hit.decision || !hit.replaced) return hit;
  const otherPath = shardFor(ledger, hit.current);
  if (!otherPath || otherPath === path) return hit;
  const there = resolveInShard(await shardOf(otherPath), hit.current);
  return there.found ? { ...hit, decision: there.decision, provisional: there.provisional } : hit;
}
