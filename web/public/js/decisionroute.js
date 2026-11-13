// Decision addresses (D121): `/d/<id>/`, a decision's short opaque id from the minted-key
// ledger. Like `/k/` and `/c/` (caseaddress.js), it isn't a file: the single-page-application
// fallback serves the reader, which reads the address here.
//
// The reader opens a CourtListener record no citation reaches this way. Each index build
// has a decision-route table beside its files, `<base>d/<c>.json.gz` on idx.stare.pub,
// where `c` is the id's sixth character (the last digit of its sequence number). Its
// `records` map a CourtListener-only decision's id to the records it opens,
// `{ cluster, hash }`, the record at `cl/c/<cluster>/<hash>.json.gz` on data.stare.pub. Its
// `cap` map a decision the ledger joined such a record to, one with CAP printings, to those
// printings and the decision's key (D208, 2026-11-10: the ledger ruled them one decision, so
// the address opens the CAP printing, picked as for `/k/`). A 2 KB shard and the index
// manifest the reader already reads are all a lookup costs.
//
// An id is seven characters of Crockford's base32 in lower case (`0-9a-z` without `i`, `l`,
// `o`, `u`): six digits, the decision's sequence number, then a Luhn mod 32 check character.

import { fetchCached, gunzip } from './cache.js';
import { ClRecordError, fetchClRecord } from './cl.js';
import { indexPath } from './manifest.js';
import { indexUrl } from './sources.js';
import { WasmLoadError } from './wasm.js';

export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_DIGITS = 6;

/** The Luhn mod 32 check character for six base32 digits. */
export function checkChar(digits) {
  let factor = 2;
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const addend = factor * ID_ALPHABET.indexOf(digits[i]);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / 32) + (addend % 32);
  }
  return ID_ALPHABET[(32 - (sum % 32)) % 32];
}

/**
 * An id as typed, made canonical: lower case, Crockford's readings of the letters the
 * alphabet leaves out (`i` and `l` as `1`, `o` as `0`), or null when that isn't an id:
 * seven characters of the alphabet whose last checks the six before it, and not all zeros.
 */
export function normalizeId(typed) {
  const id = String(typed ?? '').trim().toLowerCase().replace(/[il]/g, '1').replace(/o/g, '0');
  if (id.length !== ID_DIGITS + 1 || [...id].some((c) => !ID_ALPHABET.includes(c))) return null;
  if (/^0+$/.test(id.slice(0, ID_DIGITS))) return null;
  return checkChar(id.slice(0, ID_DIGITS)) === id[ID_DIGITS] ? id : null;
}

/**
 * What a path names: `{ kind: 'd', id }` for `/d/<id>/` (the id canonical), `{ kind: 'bad',
 * prefix: 'd' }` for a `/d/` path that names no id, and null for any other path.
 */
export function parseDecisionPath(pathname) {
  const m = String(pathname || '').match(/^\/d\/(.*)$/);
  if (!m) return null;
  let rest;
  try {
    rest = decodeURIComponent(m[1]);
  } catch {
    return { kind: 'bad', prefix: 'd' };
  }
  const body = rest.replace(/\/$/, '');
  const id = body.includes('/') ? null : normalizeId(body);
  return id ? { kind: 'd', id } : { kind: 'bad', prefix: 'd' };
}

/** The path for an id: `/d/075000d/`. */
export function decisionPath(id) {
  return `/d/${id}/`;
}

/** The table shard an id is in, under the index build's base: `d/<sixth character>.json.gz`. */
export function shardPath(id) {
  return `d/${id[ID_DIGITS - 1]}.json.gz`;
}

/**
 * The records `id` opens in a parsed shard (`{ records: { <id>: [{ cluster, hash }] } }`), as
 * the entries cl.js's fetchClRecord reads (`{ cluster_id, hash }`); empty for none.
 */
export function recordsIn(shard, id) {
  const rows = shard?.records?.[id];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => Number.isSafeInteger(r?.cluster) && /^[0-9a-f]{16}$/.test(r?.hash || ''))
    .map((r) => ({ source: 'cl', cluster_id: r.cluster, hash: r.hash }));
}

// A shard is immutable under its build's base, so it's kept in the browser cache with the
// index files (cache.js prunes other builds' copies).
async function loadShard(id) {
  const key = await indexPath(shardPath(id));
  const bytes = await fetchCached('bins', key, indexUrl(key));
  return JSON.parse(new TextDecoder().decode(await gunzip(bytes)));
}

/**
 * The CAP decision `id` names in a parsed shard (`{ cap: { <id>: { key, sources, clusters } }
 * }`), as `{ key, sources, clusters }` with only its `cap:` sources and the CourtListener
 * clusters joined to it that no citation reaches, or null.
 */
export function capIn(shard, id) {
  const d = shard?.cap?.[id];
  const sources = Array.isArray(d?.sources) ? d.sources.filter((s) => /^cap:/.test(s)) : [];
  if (!sources.length) return null;
  const clusters = Array.isArray(d.clusters) ? d.clusters.filter((c) => Number.isSafeInteger(c)) : [];
  return { key: typeof d.key === 'string' ? d.key : null, sources, clusters };
}

/**
 * Resolves `id` (canonical) from the live build's table: `{ found: true, records }` with
 * the entries a CourtListener-only decision opens, `{ found: true, cap: { key, sources } }`
 * for a decision with CAP printings, or `{ found: false }` when the table has neither (or
 * the build has no table: its shard answers 404). Throws when the table can't be reached.
 * `deps.loadShard` replaces the fetch in tests.
 */
export async function resolveDecision(id, deps = {}) {
  let shard;
  try {
    shard = await (deps.loadShard || loadShard)(id);
  } catch (e) {
    if (String(e?.message).startsWith('NOT_FOUND:')) return { found: false };
    throw e;
  }
  const cap = capIn(shard, id);
  if (cap) return { found: true, cap };
  const records = recordsIn(shard, id);
  return records.length ? { found: true, records } : { found: false };
}

/**
 * The `n`th (from 1) of a decision's records, fetched and parsed, in the shape resolve.js
 * gives a CourtListener record at a page, with `decision` (the id) and `records` for
 * switching between them, and no page: `caseFile` is `cl/<cluster>`, `allCases` every
 * record the id opens. `deps.fetchRecord` replaces the fetch in tests.
 */
export async function openDecisionRecord(id, records, n, onStatus = () => {}, deps = {}) {
  const k = n >= 1 && n <= records.length ? n : 1;
  onStatus('Fetching case data...');
  let caseData;
  try {
    caseData = await (deps.fetchRecord || fetchClRecord)(records[k - 1]);
  } catch (e) {
    if (e instanceof WasmLoadError) throw e;
    if (e instanceof ClRecordError) throw new Error(`Couldn't read the CourtListener record for this case.`);
    throw new Error(`Couldn't reach the server. Check your connection and try again.`);
  }
  const allCases = records.map((r) => `cl/${r.cluster_id}`);
  return {
    reporter: null, volume: null, page: null, caseFile: allCases[k - 1], seq: k, allCases, caseData,
    zipData: null, volumeCases: [], source: 'courtlistener', decision: id, records,
  };
}
