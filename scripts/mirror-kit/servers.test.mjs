// The mirror kit's server configurations (mirror-kit/), each run in its official image
// against a small copy laid out as a real one is, and held to the six rules in
// mirror-kit/README.md ("What the server does"). Needs Docker; `mise run test-mirror-kit`
// and the mirror-kit workflow run it. Not part of the web tests, which run without Docker.
//
// Each server is started with the kit's file as an operator would use it: Caddy with the
// Caddyfile (as compose.yaml runs it), nginx with nginx.conf in conf.d/, Apache with
// apache-vhost.conf (the rules included in the root's <Directory>) and again with
// apache.htaccess copied to the root as .htaccess. nginx and Apache are given gzip
// compression for everything at server level, so the test sees the kit turn it off under
// /mirror/.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';

import { buildFixture } from './fixture.mjs';

// Official images at pinned tags. compose.yaml uses caddy:2, which this tag is a release of.
const IMAGES = {
  caddy: 'caddy:2.10.2-alpine',
  nginx: 'nginx:1.29.3-alpine',
  httpd: 'httpd:2.4.65-alpine',
};

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The httpd image's own configuration, with the modules the kit needs turned on, mod_deflate
// compressing every type the test reads, and then `extra`.
const httpdSetup = (extra) => [
  'set -e',
  'c=/usr/local/apache2/conf/httpd.conf',
  "sed -i -e 's/^#\\(LoadModule \\(rewrite\\|headers\\|deflate\\|setenvif\\|filter\\)_module\\)/\\1/' $c",
  'printf "%s\\n" "AddOutputFilterByType DEFLATE text/html text/plain application/json application/gzip application/pdf" "AddEncoding x-gzip .gz" >> $c',
  ...extra,
  'exec httpd-foreground',
].join('\n');

const SERVERS = {
  caddy: (root) => ({
    port: 8080,
    args: [
      '-v', `${root}:/srv/stare:ro`, '-e', 'STARE_ROOT=/srv/stare',
      IMAGES.caddy, 'caddy', 'run', '--config', '/srv/stare/kit/Caddyfile', '--adapter', 'caddyfile',
    ],
  }),
  nginx: (root) => ({
    port: 8080,
    args: [
      '-v', `${root}:/srv/stare:ro`,
      '-v', `${root}/kit/nginx.conf:/etc/nginx/conf.d/default.conf:ro`,
      IMAGES.nginx, 'sh', '-c',
      'printf "gzip on;\\ngzip_min_length 1;\\ngzip_types *;\\ngzip_proxied any;\\n" > /etc/nginx/conf.d/00-gzip.conf && exec nginx -g "daemon off;"',
    ],
  }),
  'httpd (vhost)': (root) => ({
    port: 80,
    args: [
      '-v', `${root}:/srv/stare:ro`, IMAGES.httpd, 'sh', '-c', httpdSetup([
        'printf "%s\\n" "Define STARE_ROOT /srv/stare" "Include /srv/stare/kit/apache-vhost.conf" >> $c',
      ]),
    ],
  }),
  'httpd (.htaccess)': (root) => ({
    port: 80,
    args: [
      '-v', `${root}:/srv/stare:ro`, IMAGES.httpd, 'sh', '-c', httpdSetup([
        "sed -i -e 's#^DocumentRoot .*#DocumentRoot \"/srv/stare\"#' -e 's#^<Directory \"/usr/local/apache2/htdocs\">#<Directory \"/srv/stare\">#' $c",
        // The htdocs <Directory> block is now the root's; let .htaccess files in.
        "sed -i -e '/<Directory \"\\/srv\\/stare\">/,/<\\/Directory>/ s/AllowOverride None/AllowOverride FileInfo Options Indexes/' $c",
      ]),
    ],
  }),
};

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout on ${path}`)));
    req.end();
  });
}

async function waitFor(port, id) {
  const end = Date.now() + 60_000;
  let last;
  while (Date.now() < end) {
    try {
      const r = await get(port, '/index.html');
      if (r.status === 200) return;
      last = new Error(`status ${r.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  let logs = '';
  try { logs = docker('logs', id); } catch { /* gone */ }
  throw new Error(`server never answered: ${last?.message}\n${logs}`);
}

const NAV = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' };
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0, must-revalidate';

let fixture;
before(() => { fixture = buildFixture(); });
after(() => fixture?.cleanup());

for (const [name, config] of Object.entries(SERVERS)) {
  describe(name, () => {
    let id;
    let port;

    before(async () => {
      const { port: inner, args } = config(fixture.root);
      id = docker('run', '-d', '--rm', '-p', `127.0.0.1::${inner}`, ...args);
      port = Number(docker('port', id, `${inner}/tcp`).split('\n')[0].split(':').pop());
      await waitFor(port, id);
    });

    after(() => {
      if (id) {
        try { docker('rm', '-f', id); } catch { /* already gone */ }
      }
    });

    test('rule 1: real files win, through the site symlink', async () => {
      const home = await get(port, '/', NAV);
      assert.equal(home.status, 200);
      assert.match(home.headers['content-type'], /^text\/html/);
      assert.match(home.body.toString(), /FIXTURE-SITE-INDEX/);
      for (const path of ['/about', '/about/']) {
        const page = await get(port, path, NAV);
        assert.equal(page.status, 200, path);
        assert.match(page.body.toString(), /FIXTURE-ABOUT/, path);
      }
      const js = await get(port, '/_astro/app.0123abcd.js');
      assert.equal(js.status, 200);
      assert.equal(js.body.toString(), fixture.files['site/_astro/app.0123abcd.js']);
      assert.match(js.headers['content-type'], /javascript/);
      // A real file with a navigation header is still that file.
      const key = await get(port, '/.well-known/stare-release-key.pub', NAV);
      assert.equal(key.status, 200);
      assert.equal(key.headers['content-type'].replace(/\s/g, '').toLowerCase(), 'text/plain;charset=utf-8');
      assert.equal(key.body.toString(), fixture.files['site/.well-known/stare-release-key.pub']);
    });

    test('rule 2: a navigation to a missing path gets the reader with a 200', async () => {
      for (const path of ['/k/us/dc/69/1943-05-11/', '/c/us/a2d/31/647/', '/no/such/page']) {
        const r = await get(port, path, NAV);
        assert.equal(r.status, 200, path);
        assert.match(r.headers['content-type'], /^text\/html/, path);
        assert.match(r.body.toString(), /FIXTURE-SITE-INDEX/, path);
        assert.equal(r.headers['cache-control'], REVALIDATE, path);
      }
    });

    test('rule 2: any other request for a missing path is a 404', async () => {
      for (const headers of [{}, { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Mode': 'no-cors' }, { Accept: 'text/html' }]) {
        for (const path of ['/k/us/dc/69/1943-05-11/', '/js/missing.js', '/no/such/page']) {
          const r = await get(port, path, headers);
          assert.equal(r.status, 404, `${path} ${JSON.stringify(headers)}`);
          assert.doesNotMatch(r.body.toString(), /FIXTURE-SITE-INDEX/);
        }
      }
    });

    test('rule 3: /mirror/ never falls back, even for a navigation', async () => {
      for (const path of ['/mirror/idx/v/v2026.11.05.3/zz/1.idx.gz', '/mirror/missing.json', '/mirror/data/cap/a2d/31.zip']) {
        for (const headers of [NAV, {}]) {
          const r = await get(port, path, headers);
          assert.equal(r.status, 404, `${path} ${JSON.stringify(headers)}`);
          assert.doesNotMatch(r.body.toString(), /FIXTURE-SITE-INDEX/);
        }
      }
    });

    test('rule 4: range requests work under /mirror/', async () => {
      const path = '/mirror/idx/v/v2026.11.05.3/a2d/31.idx.gz';
      const bytes = fixture.bytes('mirror/idx/v/v2026.11.05.3/a2d/31.idx.gz');
      const r = await get(port, path, { Range: 'bytes=100-199', 'Accept-Encoding': 'gzip, br' });
      assert.equal(r.status, 206);
      assert.equal(r.headers['content-range'], `bytes 100-199/${bytes.length}`);
      assert.equal(r.body.length, 100);
      assert.deepEqual(r.body, bytes.subarray(100, 200));
      assert.equal(r.headers['content-encoding'], undefined);
      const pdf = await get(port, '/mirror/data/pdf/us/a2d/31.pdf', { Range: 'bytes=0-3' });
      assert.equal(pdf.status, 206);
      assert.equal(pdf.body.toString(), '%PDF');
    });

    test('rule 4: nothing under /mirror/ is compressed on the fly', async () => {
      for (const path of ['/mirror/mirror.json', '/mirror/idx/manifest.json', '/mirror/data/crk/ledger/latest.json']) {
        const r = await get(port, path, { 'Accept-Encoding': 'gzip, deflate, br' });
        assert.equal(r.status, 200, path);
        assert.equal(r.headers['content-encoding'], undefined, path);
        assert.equal(r.body.toString(), fixture.files[path.slice(1)], path);
      }
    });

    test('rule 5: .gz is application/gzip with no Content-Encoding; JSON and text are UTF-8', async () => {
      for (const path of [
        '/mirror/idx/v/v2026.11.05.3/a2d/31.idx.gz',
        '/mirror/data/crk/ledger/s/0123456789abcdef.json.gz',
        '/data/citare/v1/citare-data-0123456789abcdef.bin.gz',
      ]) {
        const r = await get(port, path, { 'Accept-Encoding': 'gzip, br' });
        assert.equal(r.status, 200, path);
        assert.equal(r.headers['content-type'], 'application/gzip', path);
        assert.equal(r.headers['content-encoding'], undefined, path);
        assert.deepEqual(r.body, fixture.bytes(path.slice(1).replace(/^(?!mirror\/)/, 'site/')), path);
      }
      const json = await get(port, '/mirror/mirror.json');
      assert.equal(json.headers['content-type'].replace(/\s/g, '').toLowerCase(), 'application/json;charset=utf-8');
      const robots = await get(port, '/robots.txt');
      assert.equal(robots.headers['content-type'].replace(/\s/g, '').toLowerCase(), 'text/plain;charset=utf-8');
    });

    test('rule 6: immutable paths are cached for a year, everything else revalidates', async () => {
      const immutable = [
        '/_astro/app.0123abcd.js',
        '/wasm/stare_wasm_bg.0123456789abcdef.wasm',
        '/wasm/stare_wasm.0123456789abcdef.js',
        '/data/citare/v1/citare-data-0123456789abcdef.bin.gz',
        '/vendor/pdfjs-6.4.299-p1/pdf.min.mjs',
        '/vendor/stare-search-abc1234-rbdef5678/search.js',
        '/mirror/idx/v/v2026.11.05.3/a2d/31.idx.gz',
        '/mirror/idx/v/v2026.11.05.3/manifest.json',
        '/mirror/data/crk/ledger/s/0123456789abcdef.json.gz',
        '/mirror/data/cl/c/4893133/62f253f296600fb7.json.gz',
        '/mirror/data/pdf/us/a2d/31.pdf',
      ];
      const revalidate = [
        '/', '/index.html', '/about/', '/js/main.js', '/wasm/stare_wasm_bg.wasm', '/wasm/stare_wasm.js',
        '/robots.txt', '/mirror/mirror.json', '/mirror/idx/manifest.json',
        '/mirror/data/crk/ledger/latest.json', '/mirror/data/pdf/manifest.json',
        '/mirror/data/pdf/us/a2d/31.json',
      ];
      for (const path of immutable) {
        const r = await get(port, path);
        assert.equal(r.status, 200, path);
        assert.equal(r.headers['cache-control'], IMMUTABLE, path);
      }
      for (const path of revalidate) {
        const r = await get(port, path);
        assert.equal(r.status, 200, path);
        assert.equal(r.headers['cache-control'], REVALIDATE, path);
      }
    });

    test('the security headers stare.pub sends', async () => {
      for (const path of ['/', '/mirror/mirror.json', '/_astro/app.0123abcd.js']) {
        const r = await get(port, path);
        assert.equal(r.headers['x-content-type-options'], 'nosniff', path);
        assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin', path);
      }
    });

    test("robots.txt is the kit's, and nothing else in the root is served", async () => {
      const r = await get(port, '/robots.txt');
      assert.equal(r.status, 200);
      assert.equal(r.body.toString(), fixture.files['kit/robots.txt']);
      assert.match(r.body.toString(), /^Disallow: \/$/m);
      for (const path of ['/kit/compose.yaml', '/kit/Caddyfile', '/site.v2026.11.05.1/index.html', '/site/index.html', '/.htaccess']) {
        const got = await get(port, path);
        // Apache refuses .ht* files outright, with a 403.
        assert.ok(got.status === 404 || (path === '/.htaccess' && got.status === 403), `${path}: ${got.status}`);
      }
    });
  });
}

// compose.yaml as an operator runs it: from the copy's kit/ directory, on the port
// STARE_PORT names, with the image it names (caddy:2).
describe('compose.yaml', () => {
  let port;
  let project;
  const compose = (...args) => execFileSync('docker', ['compose', '-f', `${fixture.root}/kit/compose.yaml`, '-p', project, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STARE_PORT: String(port) },
  });

  before(async () => {
    port = await new Promise((resolve) => {
      const srv = createServer().listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    project = `stare-kit-test-${process.pid}`;
    compose('up', '-d', '--quiet-pull');
    await waitFor(port, `${project}-web-1`);
  });

  after(() => {
    if (project) {
      try { compose('down', '-v'); } catch { /* already down */ }
    }
  });

  test('serves the copy with the Caddyfile, read-only', async () => {
    const home = await get(port, '/k/us/dc/69/1943-05-11/', NAV);
    assert.equal(home.status, 200);
    assert.match(home.body.toString(), /FIXTURE-SITE-INDEX/);
    assert.equal((await get(port, '/k/us/dc/69/1943-05-11/')).status, 404);
    assert.equal((await get(port, '/mirror/mirror.json')).body.toString(), fixture.files['mirror/mirror.json']);
    const mounts = JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', `${project}-web-1`));
    const root = mounts.find((m) => m.Destination === '/srv/stare');
    assert.equal(root.RW, false);
  });
});
