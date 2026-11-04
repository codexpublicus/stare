// The reference query for stare.pub's search tree (docs/search-index.md), on the
// roaringbuckets JS client. The reader's search page implements the same steps; this one
// is what the build's measurements and ranking check run.
//
// A query is its tokens ANDed, each matching a decision through its opinion text or its
// case name, with optional facet filters. It reads:
//   1. manifest.json (once per session);
//   2. each token's shard of the term index, and each facet's shard, in parallel;
//   3. the low tiers, by multi-range requests (one per low segment touched, in parallel),
//      only when the h and m tiers can't give a full page: m2 parts and the id chunks a
//      bound needs, narrowing the bound over at most two rounds (docs/search-index.md,
//      "Running a query");
//   4. the page's cards, one multi-range request per cards segment they fall in.

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
// A host that ignores Range answers 200 with the whole file. idx.stare.pub did that for
// format 1's low.bin and cards.bin on a cold cache miss, since Cloudflare won't cache an
// object over 512 MB on this zone's plan and fetches it without the Range header first
// (docs/search-index.md, "Where it lives"); format 2's segments are cacheable. A 200 is read only while its body stays within
// FULL_BODY_FACTOR times the bytes asked for, plus FULL_BODY_SLACK; past that it is cancelled
// and the request sent once more, and a second such answer fails the read.
const FULL_BODY_FACTOR = 4;
const FULL_BODY_SLACK = 64 * 1024;
// Fetch a term's whole low tier along with the m2 tier when it's at most this big.
const LOW_ALL_BYTES = 128 * 1024;
// Read about this much of the low tiers per narrowing round (the cheapest token always goes,
// within LOW_CAP). A token left unread is partial: it doesn't filter the candidates, and
// scores only what was read.
const LOW_BUDGET = 512 * 1024;
// At most this much of the low tiers in a query's narrowing: a token whose chunks would pass it
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
// `fetch`: the fetch to read with. The default calls the global one through a wrapper,
// because the session keeps it as `s.fetch` and a browser's fetch, called with any `this`
// but the window, throws "Illegal invocation".
export async function openSearch(base, { fetch: fetchFn = (...args) => globalThis.fetch(...args), manifest } = {}) {
  const url = base.replace(/\/$/, '');
  let raw = manifest;
  if (!raw) {
    const res = await fetchFn(`${url}/manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} reading manifest.json`);
    raw = await res.json();
  }
  const meta = raw.metadata?.search;
  if (!meta) throw new Error('not a stare search tree: the manifest has no metadata.search');
  if (meta.format !== 'stare-search' || meta.format_version !== 3) {
    throw new Error(`unsupported search format ${meta.format} ${meta.format_version}`);
  }
  const ds = new Dataset(url, parseManifest(raw), fetchFn);
  return { ds, meta, url, fetch: fetchFn, manifest: raw };
}

/**
 * A 200's body, or null when it passes `limit` bytes: then the request is aborted and the
 * body cancelled as soon as that shows, from Content-Length or while streaming, so a
 * multi-gigabyte file is never downloaded.
 */
async function boundedBody(res, limit, ctl) {
  const stop = async () => {
    ctl.abort();
    try {
      await res.body?.cancel();
    } catch {
      // already aborted
    }
    return null;
  };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return stop();
  if (!res.body?.getReader) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > limit ? null : all;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (e) {
      if (ctl.signal.aborted) return null;
      throw e;
    }
    if (step.done) break;
    total += step.value.length;
    if (total > limit) {
      ctl.abort();
      try {
        await reader.cancel();
      } catch {
        // already aborted
      }
      return null;
    }
    chunks.push(step.value);
  }
  const all = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    all.set(c, pos);
    pos += c.length;
  }
  return all;
}

/**
 * One ranged request for `group`: { status, type, contentRange, body }. A 200 whose body
 * is far bigger than the ranges is abandoned and the request retried once (see
 * FULL_BODY_FACTOR).
 */
async function fetchGroup(s, path, group) {
  const want = group.reduce((n, g) => n + (g.end - g.start), 0);
  const limit = want * FULL_BODY_FACTOR + FULL_BODY_SLACK;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const res = await s.fetch(`${s.url}/${path}`, {
      headers: { Range: multiRangeHeader(group) },
      signal: ctl.signal,
    });
    const head = {
      status: res.status,
      type: res.headers.get('content-type') || '',
      contentRange: res.headers.get('content-range') || '',
    };
    if (res.status !== 200) return { ...head, body: new Uint8Array(await res.arrayBuffer()) };
    const body = await boundedBody(res, limit, ctl);
    if (body) return { ...head, body };
  }
  throw new Error(
    `${path} answered a range request for ${want} bytes with the whole file, twice; not reading it`
  );
}

/**
 * Byte ranges of a segmented file (`metadata.search.files.low` or `.cards`): one address
 * space stored as segments of `segment_bytes`, segment n at `segments` with `{segment}`
 * replaced by n. The ranges are coalesced, cut at segment edges and read by multi-range
 * requests of at most MAX_RANGES ranges per segment, every segment's in parallel. Returns
 * get(start, end) for any range inside one asked for, joined across segments where needed.
 */
export async function readRanges(s, file, ranges) {
  const size = file.segment_bytes;
  const bySegment = new Map();
  for (const r of coalesceRanges(ranges.map((x) => ({ start: x.start, end: x.end })))) {
    for (let a = r.start; a < r.end; ) {
      const n = Math.floor(a / size);
      const b = Math.min(r.end, (n + 1) * size);
      if (!bySegment.has(n)) bySegment.set(n, []);
      bySegment.get(n).push({ start: a - n * size, end: b - n * size });
      a = b;
    }
  }
  const requests = [];
  for (const [n, local] of bySegment) {
    const path = file.segments.replace('{segment}', String(n));
    for (let i = 0; i < local.length; i += MAX_RANGES) {
      requests.push(readSegment(s, path, local.slice(i, i + MAX_RANGES), n * size));
    }
  }
  const parts = (await Promise.all(requests)).flat().sort((x, y) => x.start - y.start);
  return (start, end) => {
    const first = parts.findIndex((p) => p.start <= start && start < p.end);
    if (first >= 0 && end <= parts[first].end) {
      const p = parts[first];
      return p.bytes.subarray(start - p.start, end - p.start);
    }
    // straddles segments: join the consecutive parts that cover it
    const out = new Uint8Array(end - start);
    let at = start;
    for (let i = first; i >= 0 && i < parts.length && at < end; i++) {
      const p = parts[i];
      if (p.start > at || p.end <= at) break;
      const take = p.bytes.subarray(at - p.start, Math.min(end, p.end) - p.start);
      out.set(take, at - start);
      at += take.length;
    }
    if (at < end) throw new Error(`range ${start}-${end} of ${file.segments} was not read`);
    return out;
  };
}

/** One multi-range request on one segment; its parts, at `base` + their offsets. */
async function readSegment(s, path, group, base) {
  const res = await fetchGroup(s, path, group);
  const parts = [];
  if (res.status === 200) {
    for (const g of group) {
      if (g.end > res.body.length) throw new Error(`${path} is ${res.body.length} bytes, short of ${g.end}`);
      parts.push({ start: g.start, end: g.end, bytes: res.body.subarray(g.start, g.end) });
    }
  } else if (res.status === 206) {
    if (res.type.toLowerCase().startsWith('multipart/byteranges')) {
      parts.push(...parseMultipartByteranges(res.body, res.type));
    } else {
      const m = /bytes (\d+)-(\d+)/.exec(res.contentRange);
      if (!m) throw new Error(`${path} answered 206 with no Content-Range`);
      parts.push({ start: Number(m[1]), end: Number(m[2]) + 1, bytes: res.body });
    }
  } else {
    throw new Error(`HTTP ${res.status} reading ${path}`);
  }
  return parts.map((p) => ({ start: base + p.start, end: base + p.end, bytes: p.bytes }));
}

function idf(n, df) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * One term's state from its shard: text ids with their codes, name ids with priors. A code is
 * `level << bits | prior`; keys name the level as a digit and the prior class as a hex digit.
 */
function parseTerm(term, entries, bits) {
  const t = { term, df: 0, text: new Map(), name: new Map(), nameCount: 0, low: null, complete: true, stopName: false };
  const prefix = `${term}#`;
  for (const e of entries) {
    const kind = e.key.slice(prefix.length);
    if (kind === 'd') {
      t.df = decodeRoaring(e.bitmapBytes)[0];
    } else if (kind === 's') {
      t.stopName = true;
    } else if (kind === 'l') {
      t.low = e.refs;
      t.complete = false;
    } else if (kind[0] === 'h' || kind[0] === 'm') {
      const code = (Number(kind[1]) << bits) | parseInt(kind.slice(2), 16);
      for (const id of decodeRoaring(e.bitmapBytes)) t.text.set(id, code);
    } else if (kind[0] === 'n') {
      const prior = parseInt(kind.slice(1), 16);
      for (const id of decodeRoaring(e.bitmapBytes)) t.name.set(id, prior);
    }
  }
  if (!t.df) t.df = t.text.size;
  t.nameCount = t.name.size;
  return t;
}

/** Frames of a low-tier part, (code, bitmap) each, into a term's text map. */
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
  const get = await readRanges(s, s.meta.files.low, ranges);
  for (const { term, refs } of wants) {
    for (const r of refs) addFrames(term, get(r.offset, r.offset + r.length));
  }
}

const YEAR = /^\d{4}$/;
// A closed year range up to this many years long reads its years' keys one by one, which
// touches only the year index shards that hold them; a longer or open one reads the
// whole year index (13 shards, about 400 KB, on all of CAP and CourtListener).
const YEAR_KEYS_MAX = 500;

function yearBound(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const y = String(v);
  if (!YEAR.test(y)) throw new Error(`filters.${name} must be a four-digit year, not ${JSON.stringify(v)}`);
  return y;
}

/**
 * The ids of the decisions from `from` to `to` (either null for an open end), as the union
 * of the years' own keys: in `court_year`, every `<court>/<year>` key of the court (one
 * prefix read, so only the years the court has), and otherwise the `year` keys.
 */
async function yearRangeIds(s, court, from, to) {
  const lo = from ?? '0000';
  const hi = to ?? '9999';
  if (lo > hi) return [];
  let entries;
  if (court) {
    const prefix = `${court}/`;
    entries = (await s.ds.searchPrefix('court_year', prefix)).filter((e) => {
      const y = e.key.slice(prefix.length);
      return y >= lo && y <= hi;
    });
  } else if (from && to && Number(to) - Number(from) < YEAR_KEYS_MAX) {
    const keys = [];
    for (let y = Number(from); y <= Number(to); y++) keys.push(String(y).padStart(4, '0'));
    entries = (await Promise.all(keys.map((k) => s.ds.searchExact('year', k)))).map((found) => found[0]).filter(Boolean);
  } else {
    entries = (await s.ds.searchPrefix('year', '')).filter((e) => e.key >= lo && e.key <= hi);
  }
  const ids = new Set();
  for (const e of entries) for (const id of decodeRoaring(e.bitmapBytes)) ids.add(id);
  return Uint32Array.from(ids).sort();
}

async function facetIds(s, filters) {
  const f = { ...filters };
  const from = yearBound(f.year_from, 'year_from');
  const to = yearBound(f.year_to, 'year_to');
  delete f.year_from;
  delete f.year_to;
  const lookups = [];
  if (from || to) {
    if (f.year) throw new Error('filters: give year, or year_from and year_to, not both');
    lookups.push(yearRangeIds(s, f.court, from, to));
    delete f.court;
  } else if (f.court && f.year) {
    lookups.push(['court_year', `${f.court}/${f.year}`]);
    delete f.court;
    delete f.year;
  }
  for (const dim of ['jurisdiction', 'court', 'year', 'reporter']) if (f[dim]) lookups.push([dim, String(f[dim])]);
  if (!lookups.length) return null;
  const sets = await Promise.all(
    lookups.map(async (l) => {
      if (!Array.isArray(l)) return l;
      const [dim, key] = l;
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
 * `filters`: { jurisdiction, court, year, reporter } (facet keys from facets.json), and
 * `year_from` and `year_to` for a range of years (either alone for an open end; with
 * `court`, the court's years in the range), in place of `year`.
 */
export async function search(s, query, { filters = {}, limit = 20, cards = true } = {}) {
  const words = [...new Set(tokens(query))];
  if (!words.length) return { hits: [], total: 0, exact: true, stage: 0, relaxed: false, tokens: words };
  const { meta } = s;
  const [facet, ...shards] = await Promise.all([
    facetIds(s, filters),
    ...words.map((w) => s.ds.searchPrefix('terms', `${w}#`)),
  ]);
  const terms = words.map((w, i) => parseTerm(w, shards[i], meta.scoring.prior_bits));
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
  const bits = sc.prior_bits;
  const mask = (1 << bits) - 1;
  const nameLevel = sc.level_scores[sc.name_level];
  const scored = cands.map((id) => {
    let score = 0;
    let prior = -1;
    let namePrior = -1;
    let name = 0;
    let nameTokens = 0;
    let nameIdf = 0;
    // tokens the case name has: name postings, or a stop name's top-level text posting (its
    // name decisions were folded there)
    let inName = 0;
    for (const { t, idf: w, nidf } of weights) {
      const code = t.text.get(id);
      if (code !== undefined) {
        score += w * sc.level_scores[code >> bits];
        prior = code & mask;
        if (t.stopName && code >> bits === sc.level_scores.length - 1) inName += 1;
      }
      const p = t.name.get(id);
      if (p !== undefined) {
        name += sc.name_weight * nidf;
        nameTokens += 1;
        nameIdf += w;
        namePrior = p;
        inName += 1;
      }
    }
    // the query is the case's name: its tokens count at name_level whatever the text's own
    // levels, and the prior name_prior_scale times, so the more cited of one name rank first
    const whole = inName === weights.length;
    if (whole) score = queryIdf * nameLevel;
    if (name && nameTokens < weights.length) name *= NAME_FLOOR + (1 - NAME_FLOOR) * (nameIdf / queryIdf) ** 2;
    score += name;
    // a name posting's prior class is the finer one
    const p = namePrior >= 0 ? sc.name_prior_scores[namePrior] : prior > 0 ? sc.prior_scores[prior] : 0;
    score += p * (whole ? sc.name_prior_scale : 1);
    return { id, score };
  });
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  const top = scored.slice(0, limit);
  if (cards && top.length) {
    const { stride } = meta.files.cards;
    const get = await readRanges(
      s,
      meta.files.cards,
      top.map((h) => ({ start: h.id * stride, end: (h.id + 1) * stride }))
    );
    const dec = new TextDecoder();
    for (const h of top) h.card = JSON.parse(dec.decode(get(h.id * stride, (h.id + 1) * stride)).trimEnd());
  }
  return { hits: top, ranked: scored, total: cands.length, exact, stage, relaxed, tokens: words };
}
