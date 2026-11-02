/**
 * Byte-range helpers for RoaringBuckets blob access.
 */

/** Default gap, in bytes, that two ranges may have between them and still be merged. */
export const DEFAULT_COALESCE_GAP = 1024;

/** Default upper bound, in bytes, on a single merged request. */
export const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;

/**
 * Merge byte ranges that touch, overlap, or sit within `gap` bytes of each other.
 *
 * Ranges are half-open (`start` inclusive, `end` exclusive). The input order does not
 * matter. A range that is already larger than `maxBytes` is kept whole; the cap only
 * stops further ranges from being merged into it.
 *
 * @template {{start: number, end: number}} T
 * @param {T[]} ranges - Ranges to merge
 * @param {{gap?: number, maxBytes?: number}} [options] - Merge tuning
 * @returns {Array<{start: number, end: number, members: T[]}>} Merged ranges sorted by start,
 *   each listing the input ranges it covers
 */
export function coalesceRanges(ranges, options) {
  const gap = options?.gap ?? DEFAULT_COALESCE_GAP;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_RANGE_BYTES;

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  /** @type {Array<{start: number, end: number, members: T[]}>} */
  const merged = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      range.start <= last.end + gap &&
      Math.max(last.end, range.end) - last.start <= maxBytes
    ) {
      last.end = Math.max(last.end, range.end);
      last.members.push(range);
    } else {
      merged.push({ start: range.start, end: range.end, members: [range] });
    }
  }

  return merged;
}

/**
 * Build the range cache key for bytes `[start, end)` of a file.
 *
 * The key is the URL followed by an HTTP-style inclusive byte range, for example
 * `https://host/ds/blobs/data.bin#bytes=16-57`.
 *
 * @param {string} url - File URL
 * @param {number} start - First byte (inclusive)
 * @param {number} end - Last byte (exclusive)
 * @returns {string} Cache key
 */
export function rangeCacheKey(url, start, end) {
  return `${url}#bytes=${start}-${end - 1}`;
}

/** Default cap on the byte ranges sent in one multi-range request. */
export const DEFAULT_MAX_RANGES_PER_REQUEST = 100;

/**
 * Build a `Range` header value for one or more byte ranges.
 *
 * @param {Array<{start: number, end: number}>} ranges - Half-open ranges, none empty
 * @returns {string} For example `bytes=0-31,100-113`
 */
export function multiRangeHeader(ranges) {
  return `bytes=${ranges.map((r) => `${r.start}-${r.end - 1}`).join(',')}`;
}

/**
 * Parse a `Content-Range` header such as `bytes 16-57/1000` or `bytes 16-57/*`.
 *
 * @param {string | null | undefined} value - Header value
 * @returns {{start: number, end: number, size: number | null} | null} The half-open range
 *   it names and the file size (null when the server sent `*`), or null if `value` is
 *   missing or isn't a satisfied byte range
 */
export function parseContentRange(value) {
  const match = /^\s*bytes\s+(\d+)-(\d+)\s*\/\s*(\d+|\*)\s*$/i.exec(value ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]) + 1;
  if (end <= start) return null;
  return { start, end, size: match[3] === '*' ? null : Number(match[3]) };
}

/**
 * Read the boundary parameter from a `multipart/byteranges` Content-Type.
 *
 * @param {string | null | undefined} contentType - Content-Type header value
 * @returns {string | null} The boundary, unquoted, or null if this isn't multipart/byteranges
 *   or has no boundary
 */
export function multipartBoundary(contentType) {
  const text = contentType ?? '';
  const semi = text.indexOf(';');
  const type = (semi < 0 ? text : text.slice(0, semi)).trim().toLowerCase();
  if (type !== 'multipart/byteranges' || semi < 0) return null;
  const param = /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  for (const [, name, raw] of text.slice(semi).matchAll(param)) {
    if (name.toLowerCase() !== 'boundary') continue;
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw.trim();
    return value || null;
  }
  return null;
}

/**
 * Find `needle` in `haystack` at or after `from`.
 *
 * @param {Uint8Array} haystack - Bytes to search
 * @param {Uint8Array} needle - Bytes to find
 * @param {number} from - First index to try
 * @returns {number} Index of the first match, or -1
 */
function indexOfBytes(haystack, needle, from) {
  for (
    let i = haystack.indexOf(needle[0], from);
    i !== -1;
    i = haystack.indexOf(needle[0], i + 1)
  ) {
    if (bytesAt(haystack, needle, i)) return i;
  }
  return -1;
}

/**
 * Whether `needle` occurs in `haystack` at index `at`.
 *
 * @param {Uint8Array} haystack - Bytes to look in
 * @param {Uint8Array} needle - Bytes to match
 * @param {number} at - Index to compare at
 * @returns {boolean}
 */
function bytesAt(haystack, needle, at) {
  if (at + needle.length > haystack.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (haystack[at + j] !== needle[j]) return false;
  }
  return true;
}

const CR = 0x0d;
const LF = 0x0a;
const HYPHEN = 0x2d;

/**
 * Split a `multipart/byteranges` response body into its parts.
 *
 * Each part's length comes from its own `Content-Range` header, and exactly that many
 * bytes are taken as its body. The boundary is only looked for where a part starts, so
 * blob bytes that happen to contain the boundary string don't split a part.
 *
 * @param {Uint8Array} body - Whole response body
 * @param {string} contentType - The response's Content-Type, which names the boundary
 * @returns {Array<{start: number, end: number, bytes: Uint8Array}>} Parts in the order the
 *   server sent them; `start` and `end` are the half-open file range each part holds
 */
export function parseMultipartByteranges(body, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    throw new Error(`Not a multipart/byteranges Content-Type with a boundary: ${contentType}`);
  }
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const decoder = new TextDecoder('latin1');
  /** @type {Array<{start: number, end: number, bytes: Uint8Array}>} */
  const parts = [];

  let pos = indexOfBytes(body, delimiter, 0);
  if (pos < 0) throw new Error('multipart/byteranges body has no boundary');
  for (;;) {
    pos += delimiter.length;
    if (body[pos] === HYPHEN && body[pos + 1] === HYPHEN) return parts; // closing delimiter

    // Rest of the delimiter line (transport padding), then the part's header lines
    let lineEnd = body.indexOf(LF, pos);
    if (lineEnd < 0) throw new Error('Truncated multipart/byteranges body');
    pos = lineEnd + 1;
    /** @type {{start: number, end: number, size: number | null} | null} */
    let range = null;
    for (;;) {
      lineEnd = body.indexOf(LF, pos);
      if (lineEnd < 0) throw new Error('Truncated multipart/byteranges part headers');
      const line = decoder.decode(body.subarray(pos, lineEnd)).replace(/\r$/, '');
      pos = lineEnd + 1;
      if (line === '') break;
      const colon = line.indexOf(':');
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === 'content-range') {
        range = parseContentRange(line.slice(colon + 1));
      }
    }
    if (!range) throw new Error('multipart/byteranges part has no valid Content-Range');

    const length = range.end - range.start;
    if (pos + length > body.length) {
      throw new Error(
        `multipart/byteranges part for bytes ${range.start}-${range.end - 1} is truncated`
      );
    }
    parts.push({ start: range.start, end: range.end, bytes: body.subarray(pos, pos + length) });
    pos += length;

    // The next delimiter follows the part body after a CRLF (or a bare LF)
    if (body[pos] === CR) pos++;
    if (body[pos] === LF) pos++;
    if (!bytesAt(body, delimiter, pos)) {
      throw new Error('multipart/byteranges part is followed by data instead of a boundary');
    }
  }
}
