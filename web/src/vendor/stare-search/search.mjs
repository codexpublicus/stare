// The reference query for stare.pub's search tree (docs/search-index.md), on the
// roaringbuckets JS client. The reader's search page implements the same steps; this one
// is what the build's measurements and ranking check run.
//
// A query is its tokens ANDed, each matching a decision through its opinion text or its
// case name, with optional facet filters. It reads:
//   1. manifest.json (once per session);
//   2. each token's shard of the term index, and each facet's shard, in parallel;
//   3. low.bin, by multi-range requests, only when the h and m tiers can't give a full
//      page: m2 parts and the id chunks a bound needs, narrowing the bound over at most two
//      rounds (docs/search-index.md, "Running a query");
//   4. one multi-range request on cards.bin for the page's cards.

import {
  Dataset,
  coalesceRanges,
  decodeRoaring,
  multiRangeHeader,
  parseManifest,
  parseMultipartByteranges,
} from '@roaringbuckets/client';
import { tokens } from './tokenize.mjs';

const MAX_RANGES = 100;
// Fetch a term's whole low tier along with the m2 tier when it's at most this big.
const LOW_ALL_BYTES = 128 * 1024;
// Read about this much of low.bin per narrowing round (the cheapest token always goes,
// within LOW_CAP). A token left unread is partial: it doesn't filter the candidates, and
// scores only what was read.
const LOW_BUDGET = 512 * 1024;
// At most this much of low.bin in a query's narrowing: a token whose chunks would pass it
// stays partial. Without it a six-word phrase read up to 3.5 MB, most of a common word's
// low tier, for one more of the 50 known answers in the first ten.
const LOW_CAP = 1_000_000;
// A query token in a decision's case name adds name_weight * its name idf, scaled by how
// much of the query the name has: in full when the name has every token, otherwise by
// NAME_FLOOR + (1 - NAME_FLOOR) * c^2, c the idf-weighted share of the query's tokens in
// the name. A phrase whose words include a cited case's name ("supra see also prink
// rockefeller center") then ranks the opinion that has the phrase over the case it cites.
const NAME_FLOOR = 0.25;
const NARROW_ROUNDS = 2;

/** Open a search tree at `base` (the URL of `.../v/<version>/search`). */
// `manifest`: the manifest's JSON when the caller has it already (a warm session).
export async function openSearch(base, { fetch: fetchFn = globalThis.fetch, manifest } = {}) {
  const url = base.replace(/\/$/, '');
  let raw = manifest;
  if (!raw) {
    const res = await fetchFn(`${url}/manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} reading manifest.json`);
    raw = await res.json();
  }
  const meta = raw.metadata?.search;
  if (!meta) throw new Error('not a stare search tree: the manifest has no metadata.search');
  if (meta.format !== 'stare-search' || meta.format_version !== 1) {
    throw new Error(`unsupported search format ${meta.format} ${meta.format_version}`);
  }
  const ds = new Dataset(url, parseManifest(raw), fetchFn);
  return { ds, meta, url, fetch: fetchFn, manifest: raw };
}

/** Byte ranges of one file, by multi-range requests of at most MAX_RANGES ranges. */
export async function readRanges(s, path, ranges) {
  const merged = coalesceRanges(ranges.map((r) => ({ start: r.start, end: r.end })));
  const parts = [];
  for (let i = 0; i < merged.length; i += MAX_RANGES) {
    const group = merged.slice(i, i + MAX_RANGES);
    const res = await s.fetch(`${s.url}/${path}`, { headers: { Range: multiRangeHeader(group) } });
    if (res.status === 200) {
      const all = new Uint8Array(await res.arrayBuffer());
      for (const g of group) parts.push({ start: g.start, end: g.end, bytes: all.subarray(g.start, g.end) });
    } else if (res.status === 206) {
      const body = new Uint8Array(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      if (type.toLowerCase().startsWith('multipart/byteranges')) {
        parts.push(...parseMultipartByteranges(body, type));
      } else {
        const m = /bytes (\d+)-(\d+)/.exec(res.headers.get('content-range') || '');
        parts.push({ start: Number(m[1]), end: Number(m[2]) + 1, bytes: body });
      }
    } else {
      throw new Error(`HTTP ${res.status} reading ${path}`);
    }
  }
  return (start, end) => {
    for (const p of parts) {
      if (p.start <= start && end <= p.end) return p.bytes.subarray(start - p.start, end - p.start);
    }
    throw new Error(`range ${start}-${end} of ${path} was not read`);
  };
}

function idf(n, df) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** One term's state from its shard: text ids with their codes, name ids with priors. */
function parseTerm(term, entries) {
  const t = { term, df: 0, text: new Map(), name: new Map(), nameCount: 0, low: null, complete: true };
  const prefix = `${term}#`;
  for (const e of entries) {
    const kind = e.key.slice(prefix.length);
    if (kind === 'd') {
      t.df = decodeRoaring(e.bitmapBytes)[0];
    } else if (kind === 'l') {
      t.low = e.refs;
      t.complete = false;
    } else if (kind[0] === 'h' || kind[0] === 'm') {
      const code = Number(kind[1]) * 4 + Number(kind[2]);
      for (const id of decodeRoaring(e.bitmapBytes)) t.text.set(id, code);
    } else if (kind[0] === 'n') {
      const prior = Number(kind[1]);
      for (const id of decodeRoaring(e.bitmapBytes)) t.name.set(id, prior);
    }
  }
  if (!t.df) t.df = t.text.size;
  t.nameCount = t.name.size;
  return t;
}

/** Frames of a low.bin part, (code, bitmap) each, into a term's text map. */
function addFrames(t, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos < bytes.length) {
    const code = bytes[pos];
    const length = view.getUint32(pos + 1, true);
    pos += 5;
    for (const id of decodeRoaring(bytes.subarray(pos, pos + length))) t.text.set(id, code);
    pos += length;
  }
}

function has(t, id) {
  return t.text.has(id) || t.name.has(id);
}

function inFacet(facet, id) {
  if (!facet) return true;
  let lo = 0;
  let hi = facet.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (facet[mid] < id) lo = mid + 1;
    else hi = mid;
  }
  return lo < facet.length && facet[lo] === id;
}

function candidates(terms, facet, within = null) {
  const filtering = terms.filter((t) => !t.partial);
  if (!filtering.length) return [];
  const seed = [...filtering].sort((a, b) => a.text.size + a.name.size - (b.text.size + b.name.size))[0];
  const out = [];
  const ids = new Set([...seed.text.keys(), ...seed.name.keys()]);
  for (const id of ids) {
    if (within && !within.has(id)) continue;
    if (!inFacet(facet, id)) continue;
    if (filtering.every((t) => has(t, id))) out.push(id);
  }
  return out;
}

/**
 * Complete `pending` tokens within a bound: the decisions `fixed` tokens (complete) and the
 * facet allow. Each of NARROW_ROUNDS rounds reads, in one request, the cheapest tokens'
 * m2 parts and their chunks that overlap the bound, within LOW_BUDGET; the bound then
 * shrinks to the decisions those tokens also have, and the next round needs fewer chunks.
 * A token still unread after the last round is partial.
 */
async function narrow(s, pending, fixed, facet, spent) {
  let left = [...pending];
  for (let round = 0; round < NARROW_ROUNDS && left.length; round++) {
    const done = [...fixed, ...pending.filter((t) => !left.includes(t))];
    const bound = done.length ? candidates(done, facet) : facet;
    const need = chunksOf(bound ?? []);
    const wants = left.map((t) => {
      const refs = t.low.filter((r) => (r.blobId === 0 ? !t.m2Read : need.has(r.blobId - 1)));
      return { term: t, refs, bytes: refs.reduce((n, r) => n + r.length, 0) };
    });
    wants.sort((a, b) => a.bytes - b.bytes);
    const kept = [];
    let roundBytes = 0;
    for (const w of wants) {
      // the cheapest token always goes, so every round narrows, unless it would pass LOW_CAP
      if ((!kept.length || roundBytes + w.bytes <= LOW_BUDGET) && spent.bytes + roundBytes + w.bytes <= LOW_CAP) {
        roundBytes += w.bytes;
        kept.push(w);
      }
    }
    spent.bytes += roundBytes;
    await fetchLow(s, kept);
    for (const w of kept) w.term.complete = true;
    left = left.filter((t) => !kept.some((w) => w.term === t));
  }
  for (const t of left) t.partial = true;
}

function chunksOf(ids) {
  const c = new Set();
  for (const id of ids) c.add(Math.floor(id / 65536));
  return c;
}

/** Read refs (m2 and/or chunks) of several terms in one multi-range request. */
async function fetchLow(s, wants) {
  const ranges = [];
  for (const { refs } of wants) for (const r of refs) ranges.push({ start: r.offset, end: r.offset + r.length });
  if (!ranges.length) return;
  const get = await readRanges(s, s.meta.files.low.path, ranges);
  for (const { term, refs } of wants) {
    for (const r of refs) addFrames(term, get(r.offset, r.offset + r.length));
  }
}

async function facetIds(s, filters) {
  const f = { ...filters };
  const lookups = [];
  if (f.court && f.year) {
    lookups.push(['court_year', `${f.court}/${f.year}`]);
    delete f.court;
    delete f.year;
  }
  for (const dim of ['jurisdiction', 'court', 'year', 'reporter']) if (f[dim]) lookups.push([dim, String(f[dim])]);
  if (!lookups.length) return null;
  const sets = await Promise.all(
    lookups.map(async ([dim, key]) => {
      const found = await s.ds.searchExact(dim, key);
      return found.length ? decodeRoaring(found[0].bitmapBytes) : [];
    })
  );
  let out = sets[0];
  for (const other of sets.slice(1)) {
    const keepSet = new Set(other);
    out = out.filter((id) => keepSet.has(id));
  }
  return Uint32Array.from(out);
}

/**
 * Search. Returns { hits: [{ id, score, card }], total, exact, stage, relaxed, tokens }.
 * `filters`: { jurisdiction, court, year, reporter } (facet keys from facets.json).
 */
export async function search(s, query, { filters = {}, limit = 20, cards = true } = {}) {
  const words = [...new Set(tokens(query))];
  if (!words.length) return { hits: [], total: 0, exact: true, stage: 0, relaxed: false, tokens: words };
  const { meta } = s;
  const [facet, ...shards] = await Promise.all([
    facetIds(s, filters),
    ...words.map((w) => s.ds.searchPrefix('terms', `${w}#`)),
  ]);
  const terms = words.map((w, i) => parseTerm(w, shards[i]));
  let stage = 1;
  let cands = candidates(terms, facet);
  let exact = terms.every((t) => t.complete);

  if (!exact && cands.length < limit) {
    stage = 2;
    const incomplete = terms.filter((t) => !t.complete);
    const complete = terms.filter((t) => t.complete);
    const spent = { bytes: 0 };
    if (facet || complete.length) {
      // bounded by the facet's ids or the complete tokens' candidates: read the rest
      // where the bound needs them, narrowing it as each round lands
      await narrow(s, incomplete, complete, facet, spent);
    } else {
      // two or more common tokens: every m2 tier, and the rarest token's whole low tier
      // when it is small
      const rarest = [...incomplete].sort((a, b) => a.df - b.df)[0];
      const lowBytes = rarest.low.filter((r) => r.blobId > 0).reduce((n, r) => n + r.length, 0);
      const takeAll = lowBytes <= LOW_ALL_BYTES;
      const first = incomplete.map((t) => ({
        term: t,
        refs: t === rarest && takeAll ? t.low : t.low.filter((r) => r.blobId === 0),
      }));
      await fetchLow(s, first);
      spent.bytes += first.reduce((n, w) => n + w.refs.reduce((m, r) => m + r.length, 0), 0);
      if (takeAll) rarest.complete = true;
      cands = candidates(terms, facet);
      if (cands.length < limit) {
        stage = 3;
        if (!rarest.complete) {
          const refs = rarest.low.filter((r) => r.blobId > 0);
          await fetchLow(s, [{ term: rarest, refs }]);
          spent.bytes += refs.reduce((n, r) => n + r.length, 0);
          rarest.complete = true;
        }
        // m2 is in already; only chunks from here
        for (const t of incomplete) if (t !== rarest) t.m2Read = true;
        await narrow(s, incomplete.filter((t) => t !== rarest), [rarest], facet, spent);
      }
    }
    cands = candidates(terms, facet);
    exact = !terms.some((t) => t.partial);
  }

  // Fewer than a page has every token: fill it with the decisions that have all but one
  // (with two tokens, only when none has both), scored on the tokens they have.
  let relaxed = false;
  if (cands.length < limit && (terms.length >= 3 || (!cands.length && terms.length === 2))) {
    relaxed = true;
    const union = new Set(cands);
    for (let i = 0; i < terms.length; i++) {
      for (const id of candidates(terms.filter((_, j) => j !== i), facet)) union.add(id);
    }
    cands = [...union];
  }

  const n = meta.decisions;
  const sc = meta.scoring;
  const weights = terms.map((t) => ({ t, idf: idf(n, t.df), nidf: t.nameCount ? idf(n, t.nameCount) : 0 }));
  const queryIdf = weights.reduce((m, w) => m + w.idf, 0);
  const scored = cands.map((id) => {
    let score = 0;
    let prior = -1;
    let name = 0;
    let nameTokens = 0;
    let nameIdf = 0;
    for (const { t, idf: w, nidf } of weights) {
      const code = t.text.get(id);
      if (code !== undefined) {
        score += w * sc.level_scores[code >> 2];
        prior = code & 3;
      }
      const p = t.name.get(id);
      if (p !== undefined) {
        name += sc.name_weight * nidf;
        nameTokens += 1;
        nameIdf += w;
        prior = p;
      }
    }
    if (name && nameTokens < weights.length) name *= NAME_FLOOR + (1 - NAME_FLOOR) * (nameIdf / queryIdf) ** 2;
    score += name;
    if (prior > 0) score += sc.prior_scores[prior];
    return { id, score };
  });
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  const top = scored.slice(0, limit);
  if (cards && top.length) {
    const { path, stride } = meta.files.cards;
    const get = await readRanges(
      s,
      path,
      top.map((h) => ({ start: h.id * stride, end: (h.id + 1) * stride }))
    );
    const dec = new TextDecoder();
    for (const h of top) h.card = JSON.parse(dec.decode(get(h.id * stride, (h.id + 1) * stride)).trimEnd());
  }
  return { hits: top, ranked: scored, total: cands.length, exact, stage, relaxed, tokens: words };
}
