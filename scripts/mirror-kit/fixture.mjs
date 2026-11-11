// A small self-hosted copy for the kit's server tests, laid out as stare.pub's release
// process lays out a real one (mirror-kit/README.md, "Layout"): site -> site.<version>/,
// kit/ (this repo's mirror-kit/), mirror/{mirror.json,idx/,data/}. Each file's content is
// distinct, so a test can tell which file a server answered with.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const KIT = new URL('../../mirror-kit/', import.meta.url);
const SITE_DIR = 'site.v2026.11.05.1';

const MIRROR_JSON = {
  format: 'stare-mirror',
  format_version: '1.0.0',
  upstream: 'https://stare.pub',
  release: 'v2026.11.10',
  data_date: '2026-11-08',
  tiers: [1],
  components: {
    site: { version: 'v2026.11.05.1' },
    index: { version: 'v2026.11.05.3' },
    crk: { version: 'v2026.11.08' },
    'pdf-manifest': { version: '2026-11-01' },
    kit: { version: 'v2026.11.05.1' },
  },
};

// Text long enough for every server's compression threshold, so a test would see it.
const filler = (tag) => `${tag}\n${'lorem ipsum dolor sit amet '.repeat(80)}\n`;

function idxLines() {
  const lines = [];
  for (let page = 1; page < 400; page += 1) lines.push(`${page},cap,${String(page).padStart(4, '0')}-01`);
  return `${lines.join('\n')}\n`;
}

/** Writes the copy to a new temporary directory: `{ root, files, bytes(path), cleanup() }`. */
export function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'stare-mirror-kit-'));
  const files = {};
  const binary = {};
  const put = (path, content) => {
    const real = path.startsWith('site/') ? `${SITE_DIR}/${path.slice(5)}` : path;
    const full = join(root, real);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (typeof content === 'string') files[path] = content;
    else binary[path] = content;
  };

  // The site build.
  put('site/index.html', `<!doctype html><title>reader</title><p>FIXTURE-SITE-INDEX</p>${filler('')}`);
  put('site/about/index.html', `<!doctype html><title>about</title><p>FIXTURE-ABOUT</p>`);
  put('site/robots.txt', 'FIXTURE-SITE-ROBOTS\nUser-agent: *\nAllow: /\n');
  put('site/_astro/app.0123abcd.js', `export const app = 'FIXTURE-ASTRO';\n${'//x\n'.repeat(200)}`);
  put('site/js/main.js', `export const main = 'FIXTURE-MAIN';\n`);
  put('site/wasm/stare_wasm_bg.wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  put('site/wasm/stare_wasm_bg.0123456789abcdef.wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1]));
  put('site/wasm/stare_wasm.js', 'export default 1;\n');
  put('site/wasm/stare_wasm.0123456789abcdef.js', 'export default 2;\n');
  put('site/data/citare/v1/citare-data-0123456789abcdef.bin.gz', gzipSync(Buffer.from(filler('citare'))));
  put('site/vendor/pdfjs-6.4.299-p1/pdf.min.mjs', 'export const pdfjs = 1;\n');
  put('site/vendor/stare-search-abc1234-rbdef5678/search.js', 'export const search = 1;\n');
  put('site/.well-known/stare-release-key.pub',
    'untrusted comment: minisign public key 6882DE6FA53FD7D1\nRWTR1z+lb96CaCdVkipBJO+O6KJyVIZkYQz2syiFItetSW+S74fWeKrF\n');
  symlinkSync(SITE_DIR, join(root, 'site'));

  // The kit, as the tier 1 tar carries it, and the same rules as a root .htaccess for the
  // Apache test that reads it (the other servers never serve it).
  cpSync(KIT, join(root, 'kit'), { recursive: true });
  for (const name of readdirSync(join(root, 'kit'))) {
    if (statSync(join(root, 'kit', name)).isFile()) files[`kit/${name}`] = readFileSync(join(root, 'kit', name), 'utf8');
  }
  writeFileSync(join(root, '.htaccess'), files['kit/apache.htaccess']);

  // The data.
  put('mirror/mirror.json', `${JSON.stringify(MIRROR_JSON, null, 2)}\n`);
  put('mirror/idx/manifest.json', `${JSON.stringify({ version: 'v2026.11.05.3', base: 'v/v2026.11.05.3/', idx: 1, note: filler('manifest') })}\n`);
  put('mirror/idx/reports/index.json', `${JSON.stringify({ format: 1, reports: [] })}\n`);
  put('mirror/idx/v/v2026.11.05.3/manifest.json', `${JSON.stringify({ version: 'v2026.11.05.3', idx: 1 })}\n`);
  put('mirror/idx/v/v2026.11.05.3/a2d/31.idx.gz', gzipSync(Buffer.from(idxLines()), { level: 1 }));
  put('mirror/data/crk/ledger/latest.json', `${JSON.stringify({ version: 'v2026.11.08', errata: 'https://data.stare.pub/crk/errata.json', note: filler('ledger') })}\n`);
  put('mirror/data/crk/ledger/s/0123456789abcdef.json.gz', gzipSync(Buffer.from(JSON.stringify({ keys: [], decisions: [], note: filler('shard') }))));
  put('mirror/data/crk/errata.json', '{"errata":[]}\n');
  put('mirror/data/pdf/manifest.json', `${JSON.stringify({ reporters: {}, note: filler('pdf') })}\n`);
  put('mirror/data/pdf/us/a2d/31.json', '{"pages":1}\n');
  put('mirror/data/pdf/us/a2d/31.pdf', Buffer.from(`%PDF-1.7\n${filler('pdf')}%%EOF\n`));
  put('mirror/data/cl/c/4893133/62f253f296600fb7.json.gz', gzipSync(Buffer.from('{"name":"x"}')));

  // Readable by the servers' own users inside their containers.
  const open = (dir) => {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st || name === 'site') continue;
      if (st.isDirectory()) open(p);
      else chmodSync(p, 0o644);
    }
  };
  open(root);

  return {
    root,
    files,
    bytes: (path) => {
      if (binary[path]) return binary[path];
      const real = path.startsWith('site/') ? `${SITE_DIR}/${path.slice(5)}` : path;
      return readFileSync(join(root, real));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
