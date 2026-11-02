// The fixture search tree (search-tree/, README.md) answered as idx.stare.pub answers it:
// a whole file, one range (206 with Content-Range), or several (206 multipart/byteranges,
// infra#88). web/tests/searchclient.test.js serves it through a fake fetch, and
// web/e2e/search.spec.js through Playwright routes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TREE_ROOT = fileURLToPath(new URL('./search-tree/', import.meta.url));
export const TREE_VERSION = 'v2026.10.26';
export const TREE_PATH = `v/${TREE_VERSION}/search`;
export const EXPECTED = JSON.parse(readFileSync(new URL('./search-expected.json', import.meta.url), 'utf8'));

const BOUNDARY = 'stareFixtureBoundary';

function parseRanges(header, size) {
  const m = /^bytes=(.+)$/.exec(header || '');
  if (!m) return null;
  const out = [];
  for (const spec of m[1].split(',')) {
    const r = /^\s*(\d*)-(\d*)\s*$/.exec(spec);
    if (!r) return null;
    const start = r[1] === '' ? Math.max(0, size - Number(r[2])) : Number(r[1]);
    const end = r[1] === '' || r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
    if (start <= end && start < size) out.push([start, end]);
  }
  return out.length ? out : null;
}

/**
 * The response for `path` under the tree (`v/<version>/search/cards/0.bin`) with an optional
 * Range header: { status, headers, body } (body a Buffer), or a 404.
 */
export function treeResponse(path, range) {
  let file;
  try {
    file = readFileSync(`${TREE_ROOT}${path}`);
  } catch {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not Found') };
  }
  const type = path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  const ranges = parseRanges(range, file.length);
  if (!ranges) return { status: 200, headers: { 'content-type': type }, body: file };
  if (ranges.length === 1) {
    const [s, e] = ranges[0];
    return {
      status: 206,
      headers: { 'content-type': type, 'content-range': `bytes ${s}-${e}/${file.length}` },
      body: file.subarray(s, e + 1),
    };
  }
  const parts = [];
  for (const [s, e] of ranges) {
    parts.push(Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${s}-${e}/${file.length}\r\n\r\n`));
    parts.push(file.subarray(s, e + 1));
  }
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`));
  return {
    status: 206,
    headers: { 'content-type': `multipart/byteranges; boundary=${BOUNDARY}` },
    body: Buffer.concat(parts),
  };
}

/** A fetch over the tree, for a base URL ending in `/<TREE_PATH>`; counts requests and bytes. */
export function treeFetch(stats = { requests: 0, bytes: 0 }) {
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const at = u.pathname.indexOf('/v/');
    const path = at >= 0 ? u.pathname.slice(at + 1) : u.pathname.slice(1);
    const h = init.headers || {};
    const r = treeResponse(path, h.Range ?? h.range);
    stats.requests += 1;
    stats.bytes += r.body.length;
    return new Response(r.status === 404 ? null : r.body, { status: r.status, headers: r.headers });
  };
  fn.stats = stats;
  return fn;
}
