# stare.pub site

The Astro site served at stare.pub: the landing page and case viewer (`src/pages/index.astro`),
the brief checker (`check.astro`), the full-text search (`search.astro`), `/about`, `/data`, `/updates` and its Atom feed, plus the
crawl and agent files (`robots.txt`, `sitemap.xml`, `llms.txt`, `openapi.json`,
`reporters.json` and `/schemas/`). The build is static HTML, JavaScript and CSS; the pages
resolve citations in the browser with the stare-wasm module in `public/wasm/`.

- `src/pages/`: the pages, and the build-time `robots.txt`, `updates.xml` and schema routes
- `src/lib/`, `src/data/`: figures, JSON-LD, licences, crawl rules and the curated case list
- `public/js/`: the client code (citation detection and lookup, the viewer, `/data`'s charts)
- `public/`: `llms.txt`, `openapi.json`, fonts and the WASM build
- `tests/`: Node tests (`node --test`); `e2e/`: the Playwright smoke suite

From the repo root:

| Command | What it does |
| :-- | :-- |
| `mise run build-wasm` | Builds stare-wasm, citare's data bundle and `reporters.json` into `public/` |
| `mise run build-web` | `npm ci` and `astro build` into `dist/` |
| `mise run test-js` | The Node tests (builds the WASM first) |
| `mise run e2e [url]` | The smoke suite against a deployed site, the main preview by default |
| `npm --prefix web run dev` | The Astro dev server |
| `PUBLIC_SEARCH_TREE=<url> npm --prefix web run dev` | The dev server with `/search/` reading a local search tree (`http://127.0.0.1:8765/v/<version>/search`) instead of the live build's; the tree's server must send CORS headers |

AGENTS.md at the repo root covers releases, deploys and the published formats.
