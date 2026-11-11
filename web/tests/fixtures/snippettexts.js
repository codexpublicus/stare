// The case texts behind the fixture search tree's cards, for the search page's snippets
// (web/e2e/search.spec.js): a unified index file per volume, with a zip span on each CAP
// line (D180), and the volume's zip, as idx.stare.pub and data.stare.pub serve them. The
// fixture tree's corpus (README.md) is made up and its zips aren't committed, so these
// are built here, deterministically, from the cards' routes and names: one case JSON per
// route, deflated as CAP's zips store them, each at the offset its line's span gives,
// behind a local file header as in a zip. Only the spans are read, so there is no
// central directory.
import { deflateRawSync, gzipSync } from 'node:zlib';

const LOCAL_HEADER = 30;

// A case whose text holds the query's word, the second time far from the first.
const caseJson = (name, route) => JSON.stringify({
  id: route.length,
  name,
  name_abbreviation: name,
  decision_date: '1921-02-11',
  citations: [],
  court: { name: 'Court' },
  jurisdiction: { name_long: 'Jurisdiction' },
  casebody: {
    head_matter: `${name}.`,
    opinions: [{
      type: 'majority',
      author: '',
      text: `The parties to ${name} met in the spring. The question is whether a written contract `
        + 'bound them to the price agreed, or only to a fair one; we hold it bound them. '
        + `(${route})`,
    }],
  },
});

/**
 * `{ manifestReporters, files }` for `cards` (`{ r, n }`, a route and a name): the
 * reporters and volumes to list in the index manifest, and every file to serve, by URL
 * path on its host (`idx:/v/<version>/cal/1.idx.gz`, `data:/cap/cal/1.zip`). `noSpan`
 * lists routes whose line is written without a span.
 */
export function snippetFiles(cards, version, { noSpan = [] } = {}) {
  const volumes = new Map();
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c.r)) continue;
    seen.add(c.r);
    const m = /^([a-z0-9-]+)\/([^/]+)\/(\d+)(?:-(\d+))?$/.exec(c.r);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    if (!volumes.has(key)) volumes.set(key, []);
    volumes.get(key).push({ page: Number(m[3]), seq: Number(m[4] || 1), route: c.r, name: c.n });
  }
  const files = {};
  const manifestReporters = {};
  for (const [key, cases] of volumes) {
    const [reporter, volume] = key.split('/');
    (manifestReporters[reporter] ||= []).push(volume);
    const chunks = [];
    let at = 0;
    const lines = [];
    for (const c of cases.sort((a, b) => a.page - b.page || a.seq - b.seq)) {
      const file = `${String(c.page).padStart(4, '0')}-${String(c.seq).padStart(2, '0')}`;
      const data = deflateRawSync(Buffer.from(caseJson(c.name, c.route)));
      const header = Buffer.alloc(LOCAL_HEADER + `json/${file}.json`.length);
      header.writeUInt32LE(0x04034b50, 0);
      chunks.push(header, data);
      const offset = at + header.length;
      at = offset + data.length;
      lines.push(`${c.page},cap,${file}${noSpan.includes(c.route) ? '' : `,zip=${offset}:${data.length}:8`}`);
    }
    files[`idx:/v/${version}/${key}.idx.gz`] = gzipSync(Buffer.from(`${lines.join('\n')}\n`));
    files[`data:/cap/${key}.zip`] = Buffer.concat(chunks);
  }
  return { manifestReporters, files };
}
