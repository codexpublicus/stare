# Codex Publicus

**stare.pub** — Free, serverless U.S. case law citation resolution and search.

**Repository**: `codexpublicus/stare` in the Codex Publicus GitHub org: the site, the `stare`
CLI and the library that reads the published data. The data itself (the citation index,
archival PDFs, CourtListener records) is built and published to idx.stare.pub and
data.stare.pub by a separate, private index builder. The org's shared zones, edge rules and
LFS proxy live in its private infrastructure repository, and `codexpublicus/codexpublicus.org`
is the umbrella site. Shared Cloudflare values come from the org's infrastructure stack.

## What is this?

A system for resolving legal citations (like `31 A.2d 647`) to full case text and original scanned PDFs, with no backend server. Everything is static files on Cloudflare R2, fetched with plain GETs: the index manifest, the volume's index file and the volume's case zip or the case's CourtListener record.

stare.pub aggregates published case law from the Caselaw Access Project and CourtListener, and produces it as static, self-hostable data: the citation index, case records, the reporter map and schemas, served from plain files anyone can mirror, with no account, key or per-request server. Agents and tools use it through the static files, a local CLI and a local MCP server (#162) rather than a hosted API.

Primary use case: LLM citation validation. An MCP server or local tool takes a citation and returns the case text, so an AI can verify that a cited case actually exists and says what was claimed.

## Data

Built on the [Harvard Caselaw Access Project](https://case.law/) dataset:
- **6.9 million cases** (6,920,598) decided from 1658 to 2020
- **40,622 reporter volumes** with scanned page images and ALTO OCR, all of them in the live index
- CAP's case files are CC0 1.0; see Licences below

And on [CourtListener](https://www.courtlistener.com/)'s [bulk data](https://www.courtlistener.com/help/api/bulk-data/), from Free Law Project:
- **900,342 case records** for cases CAP doesn't hold, from the export of 2026-09-30, at
  `data.stare.pub/cl/c/<cluster_id>/<hash>.json.gz` and named by the index's `cl` lines
  (index v2026.10.22)
- parallel citations from CourtListener's citation table, as `via=cl:<cluster>` aliases in the index
- each record states its terms: the Public Domain Mark 1.0 in `license`, and CourtListener,
  Free Law Project and the export date in `attribution`

## Architecture

Three interfaces to the same data, all static files:

| Interface | What it does | How it works |
|-----------|-------------|-------------|
| **Citation index** | `31 A.2d 647` → case text + PDF | One gzipped text file per volume (`page,source,ref` lines), one GET |
| **Search** | "negligence cases in California, 1990-2000" | RoaringBuckets bitmap intersection |
| **DuckLake** | SQL over 6.9M cases | Frozen DuckDB + Parquet on R2 |

Target hosting cost: **< $8/month** for everything.

## CLI

```bash
# Resolve a citation to case text
stare resolve a2d 31 647
stare resolve "31 A.2d 647"

# List the cases in a volume
stare list a2d 31

# Check citations found in a text file (or stdin)
stare check brief.txt

# Download a reporter's index + case data for offline use
stare download --reporters a2d,a3d

# Serve the Model Context Protocol over stdio, for agents
stare mcp

# Configuration and cache
stare config show
stare config set index /path/to/local/index
stare cache status
```

`--index`/`--data` flags (or `STARE_INDEX`/`STARE_DATA` env vars, or `stare config set`)
override the default sources (`https://idx.stare.pub` and `https://data.stare.pub/cap`).
Downloaded and resolved files are cached under `~/.cache/stare/`. `stare resolve`, `stare list`
and `stare check` read the one file they need out of a volume's zip (a case's JSON, the
volume's `metadata/CasesMetadata.json`) by range requests, cached under
`zips/<slug>/<volume>/`, and read a whole zip in the cache, or in a mirror directory, in place
of the requests. `stare download` doesn't
throttle requests to stare.pub's own hosts; against any other data source (static.case.law, a
mirror) it waits 700 ms between requests. A 429, or a 503 with a Retry-After, is waited out and
retried up to three times.

### `stare mcp`

`stare mcp` is an MCP server over stdin and stdout for agents that write or review legal text
(#162, design accepted as D148). Its tools are
`check_brief` (every citation in a document, as `stare check --json` gives them, with the cited
cases), `get_case` (a case's metadata and text in windows, or excerpts around a quotation with
`find`), `resolve_citation`, `find_citations_in_text` and `index_info`. It reads the same
sources and cache as the CLI, pins a session to one index build (`--index-version` names one),
and every result names the index version and the licence of each source it used. Register it
with a client as `{"command": "stare", "args": ["mcp"]}`, or `claude mcp add stare -- stare mcp`
in Claude Code. `skills/stare-citations/SKILL.md` tells an agent when and how to use it, and
`mise run mcp-smoke` runs it against the live hosts.

Linux binaries (x86_64 and aarch64, static) are attached to the `stare-cli-vX.Y.Z` releases of
this repository, built by `.github/workflows/stare-cli-release.yml`; each archive has the
binary, the reporters-db and courts-db licences and the skill.

## Status

- [x] Data source analysis (`static-case-law-mirror.md`)
- [x] Mirror static.case.law (complete 2026-09-29: 40,622 zips, 39,964 tars, `.tar.csv` files and PDFs)
- [x] Citation index (idx.stare.pub; the live build is the one `manifest.json`'s `version` names)
- [x] Website (stare.pub), with the brief checker at stare.pub/check
- [x] CourtListener records for cases CAP doesn't hold, and its parallel citations (index v2026.10.22)
- [ ] DuckLake database
- [ ] RoaringBuckets search index
- [x] MCP server (`stare mcp`, #162): stdio, five tools; pin pages, more tools and HTTP come in M2
- [ ] IPFS distribution

## Documentation

| Document | Contents |
|----------|----------|
| `docs/plans/checklist.md` | Master checklist — current status and next steps |
| `docs/plans/cap-preservation-plan.md` | Original plan: outreach contacts, risk assessment, data sources |
| `docs/plans/static-case-law-mirror.md` | Mirror status, file format analysis, aria2 setup |
| `docs/plans/extraction-plan.md` | Citation index design, R2 layout, WASM client architecture |
| `docs/plans/search-plan.md` | RoaringBuckets vs Tantivy analysis, DuckLake design, cost estimates |
| `docs/plans/courtlistener-mirror.md` | CourtListener records and the unified index |
| `AGENTS.md` | Current architecture, formats, releases and status, kept up to date |

## License

The code is PolyForm Shield 1.0.0 (the `license` in each crate's `Cargo.toml`).

The Caselaw Access Project case files on `data.stare.pub/cap/` are CC0 1.0, the terms CAP
published them under. Everything else the project produces (the citation index, the manifest
and build reports, the reporter map, the OpenAPI document and schemas, the case pages and the
site's other data) is CC BY-NC-ND 4.0, crediting stare.pub (https://stare.pub). Each CourtListener
record on `data.stare.pub/cl/c/` carries the Public Domain Mark 1.0 CourtListener puts on its bulk
data, and credits CourtListener (Free Law Project) and the export it came from.
