// One CAP case's JSON out of its volume zip with one Range request (D180, #313). The
// unified index gives each `cap` line a span, `zip=<offset>:<length>:<method>`: the
// first byte of the entry's compressed data (past its local header), its compressed
// length, and 8 (deflate) or 0 (stored) (crates/stare/src/idx.rs, `ZipSpan`). With it
// the reader and the search page's snippets fetch `bytes=<offset>-<offset+length-1>`
// from data.stare.pub and inflate it here, instead of the whole zip (1.98 MB on average)
// or its central directory. A single explicit range is a CORS-safelisted header, so the
// request needs no preflight.
//
// No WASM: the inflating is the browser's DecompressionStream('deflate-raw'). The bytes
// are cached in the cache's `zips` store (least recently used first out, like the zips)
// under the span's key, which names the index build the span came from: a build that
// reads a corrected zip writes new spans, so a cached span never outlives its zip.

import { cacheGet, cacheSet } from './cache.js';

// The methods this reader inflates.
export const DEFLATE = 8;
export const STORED = 0;

/**
 * A span as the WASM's `lookup_idx` gives it (`{ offset, length, method }`) or as a line
 * writes it (`39997:8435:8`), checked; null for anything else, a length of 0, or a
 * method this reader can't inflate (the caller then reads the zip as it would without).
 */
export function parseSpan(span) {
  let parts;
  if (typeof span === 'string') {
    if (!/^\d+:\d+:\d+$/.test(span)) return null;
    parts = span.split(':').map(Number);
  } else if (span && typeof span === 'object') {
    parts = [span.offset, span.length, span.method];
  } else {
    return null;
  }
  const [offset, length, method] = parts;
  if (![offset, length, method].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  if (length === 0 || (method !== DEFLATE && method !== STORED)) return null;
  if (!Number.isSafeInteger(offset + length)) return null;
  return { offset, length, method };
}

/** The Range header for a span: `bytes=39997-48431`. */
export const spanRange = (span) => `bytes=${span.offset}-${span.offset + span.length - 1}`;

/**
 * The cache key for a span's bytes: the zip's path, the span, and the index build it
 * came from (`v/v2026.11.05.3/`), `v/v2026.11.05.3/span/ri/69.zip@39997:8435:8`.
 */
export const spanKey = (base, reporter, folder, span) =>
  `${base || ''}span/${reporter}/${folder}.zip@${span.offset}:${span.length}:${span.method}`;

// A span the server didn't answer as asked: the caller reads the zip without it.
export class SpanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpanError';
  }
}

/** A span's bytes inflated by its method. */
export async function inflate(bytes, method) {
  if (method === STORED) return bytes;
  if (method !== DEFLATE) throw new SpanError(`zip method ${method} isn't one this reader inflates`);
  const body = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  try {
    return new Uint8Array(await new Response(body).arrayBuffer());
  } catch (e) {
    throw new SpanError(`the span doesn't inflate: ${e.message}`);
  }
}

/**
 * The entry at `span` of the zip at `url`, as `{ bytes, total }` (the compressed bytes,
 * and the zip's size from Content-Range, or null when they came from the cache), or
 * `{ whole }` when the server ignored the Range and sent the whole zip (a 200), which
 * the caller can read the case out of. Throws a SpanError when the answer is neither: a
 * 206 for other bytes, a short body. A network error is thrown as is.
 *
 * `deps`: `fetch`, `signal`, and `key` (spanKey) with `cacheGet`/`cacheSet` to keep the
 * bytes; injectable for tests.
 */
export async function fetchSpan(url, span, deps = {}) {
  const get = deps.cacheGet || cacheGet;
  const set = deps.cacheSet || cacheSet;
  if (deps.key) {
    const hit = await get('zips', deps.key).catch(() => null);
    if (hit && hit.length === span.length) return { bytes: hit, total: null };
  }
  const fetchFn = deps.fetch || globalThis.fetch;
  const res = await fetchFn(url, { headers: { Range: spanRange(span) }, signal: deps.signal });
  if (res.status === 200) return { whole: new Uint8Array(await res.arrayBuffer()) };
  if (res.status !== 206) throw new SpanError(`HTTP ${res.status} for ${url} (${spanRange(span)})`);
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec((res.headers.get('Content-Range') || '').trim());
  if (!m || Number(m[1]) !== span.offset || Number(m[2]) !== span.offset + span.length - 1) {
    throw new SpanError(`${url} answered ${spanRange(span)} with ${res.headers.get('Content-Range')}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== span.length) throw new SpanError(`${url} sent ${bytes.length} of ${span.length} bytes`);
  if (deps.key) await set('zips', deps.key, bytes).catch(() => {});
  return { bytes, total: m[3] === '*' ? null : Number(m[3]) };
}

/**
 * The case JSON at `span` as `{ text, raw, total }` (its text, its inflated bytes, and
 * the zip's size when the bytes came from the network), or `{ whole }` as fetchSpan
 * gives it.
 */
export async function readSpanText(url, span, deps = {}) {
  const got = await fetchSpan(url, span, deps);
  if (got.whole) return got;
  const raw = await inflate(got.bytes, span.method);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new SpanError(`the entry at ${spanRange(span)} of ${url} isn't UTF-8`);
  }
  return { text, raw, total: got.total };
}
