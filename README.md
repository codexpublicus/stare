# Codex Publicus

**stare.pub** — Free, serverless U.S. case law citation resolution and search.

**Repository**: `codexpublicus/stare` in the Codex Publicus GitHub org: the site, the `stare`
CLI and the library that reads the published data. The data itself (the citation index,
archival PDFs, CourtListener records) is built and published from `codexpublicus/stare-builder`.
Alongside them are `codexpublicus/gorsuch-library`, `codexpublicus/infra` (shared zones, edge rules and the LFS proxy)
and `codexpublicus/codexpublicus.org` (umbrella site). Shared Cloudflare values come from the
Pulumi stack `organization/codexpublicus-infra/prod`.

## What is this?

A system for resolving legal citations (like `31 A.2d 647`) to full case text and original scanned PDFs — with no backend server. Everything is static files on Cloudflare R2 and IPFS, queried via HTTP range requests.

Primary use case: LLM citation validation. An MCP server or local tool takes a citation and returns the case text, so an AI can verify that a cited case actually exists and says what was claimed.

## Data

Built on the [Harvard Caselaw Access Project](https://case.law/) dataset:
- **6.7 million cases** from 1658 to 2018
- **40,622 reporter volumes** with scanned page images and ALTO OCR
- All public domain (CC0)

## Architecture

Three interfaces to the same data, all static files:

| Interface | What it does | How it works |
|-----------|-------------|-------------|
| **Citation index** | `31 A.2d 647` → case text + PDF | Binary index, one HTTP range request |
| **Search** | "negligence cases in California, 1990-2000" | RoaringBuckets bitmap intersection |
| **DuckLake** | SQL over 6.7M cases | Frozen DuckDB + Parquet on R2 |

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

# Configuration and cache
stare config show
stare config set index /path/to/local/index
stare cache status
```

`--index`/`--data` flags (or `STARE_INDEX`/`STARE_DATA` env vars, or `stare config set`)
override the default sources (`https://idx.stare.pub` and `https://data.stare.pub/cap`).
Downloaded and resolved files are cached under `~/.cache/stare/`.

## Status

- [x] Data source analysis (`static-case-law-mirror.md`)
- [ ] Mirror static.case.law (~10% complete, ETA ~7 days)
- [ ] Citation index
- [ ] DuckLake database
- [ ] RoaringBuckets search index
- [ ] MCP server
- [ ] Website (stare.pub)
- [ ] IPFS distribution

## Documentation

| Document | Contents |
|----------|----------|
| `docs/plans/checklist.md` | Master checklist — current status and next steps |
| `docs/plans/cap-preservation-plan.md` | Original plan: outreach contacts, risk assessment, data sources |
| `docs/plans/static-case-law-mirror.md` | Mirror status, file format analysis, aria2 setup |
| `docs/plans/extraction-plan.md` | Citation index design, R2 layout, WASM client architecture |
| `docs/plans/search-plan.md` | RoaringBuckets vs Tantivy analysis, DuckLake design, cost estimates |

## License

The case law data is public domain (CC0). This project's code is TBD.
