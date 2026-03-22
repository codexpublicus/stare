# Codex Publicus — Agent Context

## Project Overview

**Codex Publicus** (stare.pub) is a free, serverless, publicly accessible search index over U.S. case law. It is built on RoaringBuckets with full text hosted on Cloudflare R2 and scanned reporter PDFs preserved on IPFS.

**Mission**: Acquire the complete Harvard Caselaw Access Project (CAP) dataset — full text and scanned reporter PDFs — before the project's infrastructure disappears. Build a permanent, open search index over that data.

## Repository Structure

- `cap-preservation-plan.md` — Master plan document covering data acquisition, architecture, outreach, and risk assessment.

## Key Technical Decisions

- **Search index**: RoaringBuckets binary index stored on Cloudflare R2, queryable via HTTP range requests with zero backend compute.
- **Full text**: Merged Harvard + CourtListener text on R2, deduplicated via xxHash.
- **PDFs**: IPFS content-addressed storage, pinned from homelab TrueNAS. Zero ongoing hosting cost.
- **Target cost**: Under $5/month for R2-hosted components.

## Data Sources

| Source | Content | Size | License |
|--------|---------|------|---------|
| Harvard CAP (Hugging Face) | OCR'd case text (JSONL) | 24.3 GB compressed | CC0 |
| CourtListener bulk CSV | Enriched opinions + citation graph | 324 GB | CC0 |
| case.law PDFs | Scanned reporter volumes | ~400 GB–2 TB (web PDFs) | CC0 |

## Development Phases

1. **Phase 1** (urgent): Acquire Harvard CAP PDFs before case.law goes dark — via direct bulk transfer request or scrape.
2. **Phase 2**: Download Harvard text from Hugging Face and CourtListener bulk CSV.
3. **Phase 3**: Build RoaringBuckets index, publish to R2, build resolution table.
4. **Phase 4**: Ongoing quarterly CourtListener updates pipeline.

## Language & Tooling Preferences

- Python (using `uv run python`, never bare `python`)
- `httpx` or `aiohttp` for HTTP
- `playwright` for JS-rendered pages where needed
- `sqlite3` / DuckDB for local manifests and index building
- `ipfs` CLI via subprocess for IPFS operations
- `ruff` for linting/formatting

## Important Context

- The Harvard CAP API is already dead (March 2024). Search went dark September 2024.
- PDFs are the irreplaceable asset — text can be re-derived from PDFs, not vice versa.
- The Ravel/LexisNexis exclusivity deal on CAP data expired March 2024. Data is public domain.
- Be respectful when scraping case.law: max 1–2 req/sec, identify in User-Agent.
- CourtListener's `filepath_pdf_harvard` field provides a complete manifest of Harvard PDFs — use it to avoid scraping the directory structure.
