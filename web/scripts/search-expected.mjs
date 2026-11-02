// Runs stare-builder's own reference client (not stare's copy) on the fixture search tree
// and writes what it returns, for web/tests/searchclient.test.js (web/tests/fixtures/README.md).
//
//   node web/scripts/search-expected.mjs <stare-builder client dir> <tree dir> <queries.json> <out.json>
//
// The client directory is pipelines/search-index/client at the pinned commit, with
// node_modules/@roaringbuckets/client pointing at roaringbuckets' packages/client at its pin.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [clientDir, tree, queriesPath, outPath] = process.argv.slice(2);
const { openSearch, search } = await import(pathToFileURL(resolve(clientDir, 'search.mjs')).href);

function parseRanges(header, size) {
  const m = /^bytes=(.+)$/.exec(header || '');
  if (!m) return null;
  return m[1].split(',').map((spec) => {
    const [a, b] = spec.trim().split('-');
    return [Number(a), b === '' ? size - 1 : Math.min(Number(b), size - 1)];
  });
}

async function fakeFetch(url, init = {}) {
  const path = new URL(url).pathname;
  let body;
  try {
    body = await readFile(`${tree}${path}`);
  } catch {
    return new Response(null, { status: 404 });
  }
  const range = init.headers?.Range ?? init.headers?.range;
  const ranges = parseRanges(range, body.length);
  if (!ranges) return new Response(body, { status: 200 });
  if (ranges.length === 1) {
    const [s, e] = ranges[0];
    return new Response(body.subarray(s, e + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${s}-${e}/${body.length}`, 'content-type': 'application/octet-stream' },
    });
  }
  const boundary = 'b0undary';
  const parts = [];
  for (const [s, e] of ranges) {
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${s}-${e}/${body.length}\r\n\r\n`));
    parts.push(body.subarray(s, e + 1));
  }
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return new Response(Buffer.concat(parts), {
    status: 206,
    headers: { 'content-type': `multipart/byteranges; boundary=${boundary}` },
  });
}

const queries = JSON.parse(await readFile(queriesPath, 'utf8'));
const out = [];
for (const q of queries) {
  const s = await openSearch('https://idx.test/v/v2026.10.26/search', { fetch: fakeFetch });
  const r = await search(s, q.q, { filters: q.filters ?? {}, limit: q.limit ?? 20 });
  out.push({
    ...q,
    total: r.total,
    exact: r.exact,
    stage: r.stage,
    relaxed: r.relaxed,
    tokens: r.tokens,
    ranked: r.ranked?.map((h) => [h.id, Math.round(h.score * 1e9) / 1e9]) ?? [],
    cards: r.hits.slice(0, 20).map((h) => h.card),
  });
}
await writeFile(outPath, `[\n${out.map((o) => JSON.stringify(o)).join(",\n")}\n]\n`);
console.log(`${out.length} queries`);
