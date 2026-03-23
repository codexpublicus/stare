# Search & Data Products Plan

## Overview

Three interfaces to the same underlying data, each optimized for different consumers:

| Interface | Use Case | Consumer | Backend |
|-----------|----------|----------|---------|
| **Citation index** (bin files) | Single citation → text + PDF | MCP server, CLI tool, website | R2, range requests |
| **Search index** (RoaringBuckets) | Serverless full-text + structured search | Website, API-less clients | R2, bitmap intersection via range requests |
| **DuckLake** | SQL queries, bulk analysis, research | Researchers, data scientists, DuckDB users | R2/S3, Parquet + DuckDB catalog |

All three are static files on object storage. No server. No API. No database to run.

---

## 1. Citation Index (already planned)

See `extraction-plan.md`. Binary index files with direct page offset lookup. One range request per citation. Covered.

---

## 2. Search Index: RoaringBuckets

### Why RoaringBuckets over Tantivy?

Evaluated both for serving a full-text search index as static files on R2. RoaringBuckets (lokkju/roaringbuckets) is the clear choice:

| | RoaringBuckets | Tantivy |
|---|---|---|
| **Designed for** | Static files + HTTP range requests (core design) | Local filesystem (adapted for remote) |
| **Index size (6.7M cases)** | ~50-200 MB | ~15-25 GB |
| **First query bandwidth** | ~50 KB | ~500 KB - 2 MB |
| **Cold query latency** | ~100-300ms | ~1-5s |
| **Multi-dimension AND/OR** | Native (bitmap intersection) | Supported but heavier |
| **R2-native** | Yes — EIDX v2 format built for range requests | Adapted via custom Directory trait |
| **Full-text features** | Bring your own (tokenizer, scoring offline) | Built-in BM25, phrase queries, fuzzy |
| **WASM** | Reader not yet built (format is simple) | ~1.5 MB binary, community projects |

**RoaringBuckets wins on:**
- 100x smaller index
- Purpose-built for the exact access pattern (static files, range requests, bitmap intersection)
- Multi-dimensional queries are native (term AND jurisdiction AND year)
- Tiny first-query cost (~50 KB)

**What we build offline** (not needed at query time):
- Tokenizer/stemmer for opinion text → term bitmaps
- BM25/TF-IDF scores pre-computed and stored as dimension metadata
- Positional data if phrase queries are needed later

**Tantivy is overkill**: it's a full search engine runtime, but we don't need a runtime — we have a build pipeline and a static file server.

### How RoaringBuckets works for search

The EIDX v2 format stores sorted entries (key → Roaring Bitmap + blob references) in shardable index files. Binary search on the entry table finds the term, deserializes the bitmap, and the client intersects bitmaps from multiple dimensions.

**Index sharding**: with ~500K unique terms after stemming, shard the term index by first 2 characters → hundreds of small files (~50-200 KB each). A search for "negligence" loads only the `ne` shard.

### Dimensions

| Dimension | Keys | Bitmap per key | Est. total size |
|-----------|------|---------------|----------------|
| **Jurisdiction** | ~60 | case IDs in that jurisdiction | < 50 MB |
| **Court** | ~400 | case IDs for that court | < 100 MB |
| **Year** | ~360 (1658-2018) | case IDs decided that year | < 200 MB |
| **Decade** | ~36 | case IDs in that decade | < 20 MB |
| **Reporter** | ~400 | case IDs in that reporter | < 100 MB |
| **Case name tokens** | ~50K | case IDs with that token in name | ~500 MB - 1 GB |
| **Opinion text terms** | ~500K | case IDs containing that term | ~2-5 GB (sharded) |
| **Total** | | | **~3-7 GB** |

Still tiny compared to Tantivy's 15-25 GB. And the structured dimensions (jurisdiction, court, year) are under 500 MB total — usable even without full-text.

### Query flow

```
User: "negligence cases in California, 1990-2000"

1. Client fetches manifest.json (~1 KB, cached)
2. Fetch terms shard "ne" (~100 KB) → find "negligence" bitmap
3. Fetch jurisdiction/cal bitmap (~1 MB)
4. Fetch decade/1990 bitmap (~500 KB)
5. Intersect: negligence AND california AND 1990s → matching case IDs
6. Resolve case IDs → citations → fetch text from zips

Total: 4-5 requests, ~2 MB transferred, ~200ms
```

### Relevance ranking

BM25 scores can be pre-computed during index build and stored alongside each term bitmap. The EIDX v2 format supports embedded blob references with offset/length — store per-document scores as a compact array referenced from each term entry.

At query time: intersect bitmaps to get matching case IDs, then read the pre-computed scores for those IDs from the term's blob, sort client-side. No runtime scoring needed.

### Case ID assignment

Encode reporter/volume/case_file directly into the case ID — no resolution table needed:

```
reporter_num (0-400) * 2_000_000 + volume_num (0-1500) * 1000 + case_seq (0-99)
```

Max case_id: ~800M — fits in a 32-bit int. Resolution is just math:
```
reporter = case_id / 2_000_000
volume = (case_id % 2_000_000) / 1000
case_seq = case_id % 1000
```

### Full-text search scope

**Phase 1**: structured dimensions only (jurisdiction, court, year, reporter) + case name tokens. Covers "find cases by metadata" queries. ~1-2 GB index.

**Phase 2**: opinion text terms (sharded by prefix). Covers "find cases mentioning X" queries. Adds ~2-5 GB.

**Phase 3** (if needed): positional data for phrase queries ("proximate cause"). Adds complexity and size. Evaluate whether user demand justifies it.

### Estimated index size on R2

| Phase | Size | R2 ($/month) |
|-------|------|-------------|
| Structured only | ~1-2 GB | ~$0.03 |
| + Full-text terms | ~3-7 GB | ~$0.10 |
| + Positional data | ~10-15 GB | ~$0.22 |

---

## 3. DuckLake: Frozen Queryable Database

### What is it?

A DuckLake catalog is a DuckDB file (`.ducklake`) that points to Parquet data files on object storage. Together they form a frozen, read-only SQL database that anyone can query remotely:

```sql
ATTACH 'ducklake:https://r2.stare.pub/ducklake/caselaw.ducklake' AS caselaw;
SELECT * FROM caselaw.cases WHERE jurisdiction = 'California' AND year > 1990;
```

No server. DuckDB reads the catalog via HTTP, then fetches only the needed Parquet row groups via range requests.

### Why offer this?

- **Researchers** can query 6.7M cases with SQL without downloading 80 GB
- **Data scientists** can join case law against their own datasets
- **LLM pipelines** can bulk-extract training data with filters
- **Legal tech tools** can build on it without running infrastructure
- **Reproducibility** — frozen snapshot, anyone can verify

### Full-text search in DuckLake?

**No.** DuckDB's FTS extension stores a `terms` table with one row per (document, term) posting. At 6.7M cases with ~400 terms each = 2.7 billion rows, ~60 GB. A BM25 query scans all postings for each search term — over HTTP range requests this means hundreds of fetches and 10-60 seconds per query. Not practical for interactive search.

**DuckLake FTS is viable for:**
- Metadata FTS only (case names, court names) — terms table ~100-500 MB, fast enough
- Filtered FTS — search within a pre-filtered subset (e.g., California cases only)

**Full-text search lives in RoaringBuckets**, not DuckLake.

### DuckDB extension for RoaringBuckets

A compelling bridge: build a DuckDB extension that queries our RoaringBuckets index:

```sql
SELECT * FROM caselaw.cases
WHERE case_id IN (
    SELECT * FROM roaring_search('negligence', jurisdiction='cal', year_range=[1990, 2000])
);
```

The extension fetches and intersects bitmaps, returns matching case IDs, DuckDB joins them against the Parquet data. Researchers get SQL power + efficient full-text search, all serverless.

### Schema

```sql
CREATE TABLE cases (
    case_id           INTEGER PRIMARY KEY,
    reporter_slug     VARCHAR,
    volume            INTEGER,
    case_file         VARCHAR,       -- e.g., "0647-01"
    name              VARCHAR,
    name_abbreviation VARCHAR,
    decision_date     DATE,
    docket_number     VARCHAR,
    first_page        INTEGER,
    last_page         INTEGER,
    court_id          INTEGER,
    court_name        VARCHAR,
    jurisdiction_id   INTEGER,
    jurisdiction_name VARCHAR,
    official_cite     VARCHAR,       -- e.g., "31 A.2d 647"
    opinion_text      VARCHAR,
    opinion_type      VARCHAR,       -- majority, dissent, concurrence
    opinion_author    VARCHAR,
);

CREATE TABLE citations (
    from_case_id      INTEGER,
    to_cite           VARCHAR,
    to_case_id        INTEGER,       -- NULL if not in corpus
    reporter          VARCHAR,
    category          VARCHAR,
);

CREATE TABLE courts (
    id                INTEGER PRIMARY KEY,
    name              VARCHAR,
    abbreviation      VARCHAR,
);

CREATE TABLE jurisdictions (
    id                INTEGER PRIMARY KEY,
    name              VARCHAR,
    name_long         VARCHAR,
);
```

### Partitioning

Parquet files partitioned by jurisdiction and decade for efficient predicate pushdown:

```
/ducklake/data/cases/jurisdiction=cal/decade=1990/data.parquet
/ducklake/data/cases/jurisdiction=dc/decade=1940/data.parquet
```

A query for "California cases after 1990" only reads the California partitions.

### Size estimate

| Component | Size |
|-----------|------|
| Case metadata (no text) | ~2-5 GB |
| Opinion text (Parquet) | ~15-25 GB |
| Metadata FTS index | ~1-3 GB |
| Citation graph | ~1-2 GB |
| **Total** | ~20-35 GB |

### DuckLake on R2

| Scenario | Size | R2 ($/month) |
|----------|------|-------------|
| Metadata only | ~5 GB | $0.08 |
| With text, no FTS | ~25 GB | $0.38 |
| With text + metadata FTS | ~35 GB | $0.53 |

### Downloadable subsets

```bash
# Download just California case law
duckdb -c "
  ATTACH 'ducklake:https://r2.stare.pub/ducklake/caselaw.ducklake' AS remote;
  COPY (SELECT * FROM remote.cases WHERE jurisdiction_name = 'California')
  TO 'california_cases.parquet' (FORMAT PARQUET);
"
```

Or pre-build per-jurisdiction DuckLake snapshots for popular states.

---

## How the three interfaces relate

```
                    ┌─────────────────────────┐
                    │   Mirrored Data (R2/IPFS) │
                    │   tars, zips, PDFs        │
                    └────────────┬──────────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
            ▼                    ▼                    ▼
     ┌──────────┐       ┌──────────────┐       ┌──────────┐
     │ Citation  │       │ RoaringBuckets│       │ DuckLake │
     │ Index     │       │ Search Index  │       │ Database │
     │ (.bin)    │       │ (bitmaps)     │       │ (Parquet)│
     │ ~40 MB    │       │ ~3-7 GB      │       │ ~25-35 GB│
     └────┬─────┘       └──────┬───────┘       └────┬─────┘
          │                    │                    │
          ▼                    ▼                    ▼
     MCP Server          Serverless            Researchers
     CLI Tool            Website               Data Science
     Quick Lookup        Browse/Search         SQL Queries
                         Full-text              Citation Graph
```

All three are built from the same source data (the mirrored zips). All three are static files on R2. They coexist:
- The website uses citation index for lookups + RoaringBuckets for search
- Researchers use DuckLake for SQL queries
- The DuckDB RoaringBuckets extension bridges both worlds

---

## Build order

1. **Citation index** — build first, enables MCP server and basic website
2. **DuckLake** — build second. Process all zips into Parquet, build DuckLake catalog. Validates data pipeline, assigns stable case IDs. Enables research use.
3. **RoaringBuckets search** — build third. Use the DuckLake data to generate bitmaps per dimension. Enables serverless website search.
4. **DuckDB extension** — build fourth. Bridges DuckLake SQL to RoaringBuckets full-text search.

The DuckLake build is a prerequisite for RoaringBuckets — you need all cases enumerated with stable IDs before you can build bitmaps.

---

## Total hosting cost

| Component | Backend | Size | Cost/month |
|-----------|---------|------|-----------|
| Citation index | R2 | ~40 MB | ~$0.001 |
| Zips (case text) | R2 | ~17 GB | ~$0.26 |
| Tar manifests (tar.csv) | R2 | small | ~$0 |
| Volume PDFs | R2 or IPFS | ~488 GB | $0-$7.32 |
| Tars (images + ALTO) | IPFS | ~3.9 TB | $0 |
| RoaringBuckets search index | R2 | ~3-7 GB | ~$0.10 |
| DuckLake (with text + metadata FTS) | R2 | ~35 GB | ~$0.53 |
| **Total** | | | **~$1-$8/month** |

---

## Open questions

1. **Case ID scheme**: packed encoding (reporter * 2M + volume * 1K + seq) vs sequential? Packed is simpler but may waste bitmap space if the ID space is sparse.
2. **RoaringBuckets WASM reader**: build in Rust (matches RoaringBuckets format reader) or JavaScript?
3. **DuckDB RoaringBuckets extension**: worth building? Scope and timeline?
4. **DuckLake maturity**: frozen DuckLake is new (late 2025). Use plain Parquet + `.duckdb` as a fallback?
5. **Citation graph**: include in DuckLake? Enables "all cases citing Roe v. Wade" queries.
6. **CourtListener integration**: merge their 324 GB enriched metadata? Adds richer data but significantly increases scope.
7. **Opinion text tokenization**: stemmer choice, stop words, legal-specific normalization?
