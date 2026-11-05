# Stare: Codex Publicus

**stare.pub**

A free, serverless, publicly accessible search index over U.S. case law, built on RoaringBuckets with full text hosted on Cloudflare R2 and scanned reporter PDFs preserved on IPFS.

## Purpose

Acquire the complete Harvard Caselaw Access Project dataset; full text and scanned reporter PDFs; before the project's infrastructure disappears. Build the index. Make it permanent.

---

## Current State of the Data

Harvard's Library Innovation Lab digitized ~40,000 reporter volumes (40 million pages, ~200 TB raw scans) covering 6.7 million cases from 1658 to 2018. The data exists in three forms:

1. **Scanned PDFs** of original reporter volumes, organized by jurisdiction and reporter series, currently hosted at case.law/caselaw. These are the primary source documents.
2. **OCR'd text** extracted from those scans, available as cleaned JSONL on Hugging Face (24.3 GB compressed, ~80 GB uncompressed) under CC0.
3. **CourtListener's enriched dataset** (324 GB opinions CSV), which incorporates Harvard data plus additional court-scraped opinions, with richer metadata including a `filepath_pdf_harvard` field mapping opinions to Harvard PDF paths.

Harvard announced in March 2024 that they were winding down the CAP API and search. Search was disabled September 2024. They stated they would continue hosting bulk data and individual readable cases at case.law, but this is a soft commitment from an academic lab in wind-down mode. The site is JS-rendered, which suggests maintenance is minimal. Given Harvard's current federal funding disputes, anything non-core is at risk.

The PDFs are the irreplaceable asset. The text can be re-derived from PDFs; PDFs cannot be reconstructed from text.

---

## Architecture

### Storage Layers

- **RoaringBuckets index on Cloudflare R2**: Searchable binary index with Roaring bitmap indexes across metadata dimensions (jurisdiction, court, date range, citation, case name tokens). Byte offsets enable HTTP range request queries with zero backend. Estimated index size: single-digit GB. Cost: ~$0.15/month.
- **Full text corpus on R2**: Merged Harvard + CourtListener text, deduplicated via xxHash content addressing. Estimated 80-324 GB depending on scope. Cost: $1.20-$4.86/month.
- **Reporter volume PDFs on IPFS**: Content-addressed, distributed, permanent. Pinned initially from our own storage. Per-file CIDs for granular index resolution; per-reporter directory DAGs for bulk pinning. Zero ongoing hosting cost beyond own storage.

### Resolution Flow

A query hits the RoaringBuckets index on R2 via HTTP range requests. The client intersects bitmaps locally and gets back case IDs. Each case ID resolves to:

- Full text on R2 (direct fetch)
- PDF on IPFS via CID (fetched through any IPFS gateway)
- Attribution link to CourtListener (for their enriched metadata, ongoing updates, and respect for their work)

### Cost

Under $10/month total for the R2-hosted components. IPFS pinning is local storage only.

---

## Acquisition Plan

### Phase 1: Harvard PDFs (Do This First)

The case.law site still hosts scanned reporter PDFs organized by jurisdiction and court. This is the time-sensitive acquisition.

#### Option A: Direct Request (Preferred)

Contact the Harvard Library Innovation Lab team and ask for a bulk transfer of the complete PDF corpus. This is a ~200 TB dataset of public domain scanned documents. The project is in wind-down; they may welcome someone taking a preservation copy, especially for IPFS distribution.

See the **Outreach** section below for contact details and approach.

Offer to:
- Ship them a hard drive (or multiple drives) for them to copy onto
- Pay for a drive and shipping
- Accept any format they have (raw scan TIFFs, processed PDFs, whatever exists on their storage)
- Provide a Backblaze B2 or R2 bucket for them to push to, if they prefer cloud transfer
- Credit Harvard LIL and the CAP project prominently in all public-facing materials

#### Option B: Scrape case.law

If direct transfer isn't possible or is too slow, scrape the PDFs from the live site.

The site is a JavaScript SPA, so the scraper needs to either:
- Use a headless browser (Playwright/Puppeteer) to render the jurisdiction/reporter listing pages and extract PDF URLs, or
- Reverse-engineer the API endpoints the JS frontend calls (likely simpler; check network tab for XHR requests to identify the underlying data API)

Scraper design:

1. **Enumerate jurisdictions**: Walk the case.law/caselaw page to get the list of jurisdictions and reporter series.
2. **Enumerate volumes**: For each reporter series, get the list of available volumes with PDF links.
3. **Download PDFs**: Fetch each volume PDF. Expect 10-50 MB per volume across ~40,000 volumes. Total: 400 GB to 2 TB (the 200 TB figure is raw high-res TIFFs; the web-served PDFs are likely much smaller, reduced-resolution versions).
4. **IPFS-add as you go**: Run `ipfs add` on each downloaded PDF to generate CIDs immediately. Store the mapping (jurisdiction, reporter, volume, filename) -> CID in a local SQLite database.
5. **Build directory DAGs**: After all volumes in a reporter series are downloaded, create an IPFS directory object grouping them. Record the directory CID.
6. **Rate limit**: Be respectful. This is a Harvard academic server. 1-2 requests/second max, identify yourself in the User-Agent.

Tooling: Python with httpx or aiohttp, Playwright for initial enumeration if needed, subprocess calls to `ipfs add`, SQLite for the CID manifest.

#### Option C: Use CourtListener's filepath_pdf_harvard

The CourtListener bulk CSV includes `filepath_pdf_harvard` for each opinion cluster, containing the path to the Harvard PDF. This gives you a complete manifest of what exists without scraping the case.law directory structure. Download the CourtListener quarterly bulk export, extract the `filepath_pdf_harvard` column, and use those paths to construct download URLs.

This approach works even if the case.law frontend changes, as long as the underlying file storage remains accessible.

### Phase 2: Full Text Acquisition

#### Harvard Text (Hugging Face)

```bash
huggingface-cli download free-law/Caselaw_Access_Project
```

24.3 GB compressed. Already cleaned and in JSONL format. CC0 licensed. This is straightforward.

Also grab the common-pile version which includes CourtListener data:

```bash
huggingface-cli download common-pile/caselaw_access_project
```

#### CourtListener Bulk CSV

The quarterly bulk data export is available from the CourtListener bulk data page. The opinions CSV is 324 GB. It's a PostgreSQL COPY TO dump. Key tables:

- **courts**: Court metadata
- **dockets**: Case-level metadata (docket number, case name, dates)
- **opinion-clusters**: Groups related opinions; contains judge info, date filed, citations
- **opinions**: Full text in multiple formats (html_with_citations, plain_text, xml_harvard)
- **citation-map**: The citation graph between opinions
- **citations**: Parallel citation data

Import into DuckDB or Postgres for processing. DuckDB can read the CSVs directly for building the RoaringBuckets index without needing a full Postgres setup.

### Phase 3: Build the Index

1. Load Harvard text and CourtListener metadata into DuckDB.
2. Assign stable integer IDs to each case. Use CourtListener opinion IDs where available; generate sequential IDs for Harvard-only cases.
3. xxHash each opinion's text content for deduplication across sources.
4. Build RoaringBuckets index files over:
   - Jurisdiction (bitmap per jurisdiction)
   - Court (bitmap per court)
   - Date range (bitmaps for year buckets, decade buckets)
   - Reporter/citation (bitmap per reporter series)
   - Case name tokens (inverted index as bitmaps)
5. Build resolution table mapping case ID -> R2 text path, IPFS PDF CID, CourtListener URL.
6. Publish index files and resolution table to R2.

### Phase 4: Ongoing Updates

CourtListener publishes quarterly bulk dumps. Build a pipeline that:

1. Downloads each new quarterly dump
2. Diffs against previous data (new opinions, updated citations)
3. Rebuilds affected RoaringBuckets index shards
4. Pushes updated index to R2

This keeps the index current with CourtListener's ongoing court scraping without requiring any direct court access.

---

## Outreach: Getting a Bulk Transfer

The Harvard Library Innovation Lab team built CAP and still maintains case.law. The project has Filecoin Foundation funding for their newer Institutional Data Initiative work, so they're already in the decentralized storage ecosystem. IPFS preservation of their caselaw data would align with their stated values.

### Key People

**Jack Cushman** — Director, Harvard Library Innovation Lab. Former lead developer of CAP. Appellate litigator turned software engineer. Teaches "Programming for Lawyers" at Harvard Law. ACLU board member. Berkman Klein Center fellow. He's the decision-maker for CAP data access.

- Contact: lil@law.harvard.edu (lab email, per their public contact info)
- LinkedIn: linkedin.com/in/jackcushman
- Berkman Klein profile: cyber.harvard.edu/people/jcushman
- His stated focus is "fragility of digital cultural memory" — preservation of CAP data on IPFS is directly in his wheelhouse.

**Greg Leppert** — Executive Director, Institutional Data Initiative (spun off from LIL). Chief Technologist, Berkman Klein Center. He built the CAP data pipeline and is now running IDI, which is doing the same thing for books that CAP did for caselaw. IDI is funded by the Filecoin Foundation for the Decentralized Web, so he's already thinking in IPFS/decentralized storage terms.

- LinkedIn: linkedin.com/in/gregleppert
- Berkman Klein profile: cyber.harvard.edu/people/gleppert
- He may be the most receptive to the IPFS angle given his current Filecoin-funded work.

**Matteo Cargnelutti** — Principal Engineer, Institutional Data Initiative. Former Senior Software Engineer at LIL. Specializes in digital preservation and open knowledge. Now a LIL fellow. He likely knows where the raw data lives and how it's stored.

- LIL about page: lil.law.harvard.edu/about/

**Kim Dulin** — Library Innovation Lab Director. Oversees the lab's operations.

**Adam Ziegler** — Former Director of LIL who originally led the CAP effort. Now listed as Director on the Perma.cc project page. May still have institutional context on data access policies.

**Jonathan Zittrain** — Harvard Law professor, Vice Dean for Library and Information Resources. Faculty champion of the CAP project from the start. Unlikely to handle data logistics himself, but a useful name to reference for legitimacy.

### Approach

Email lil@law.harvard.edu with CC to Jack Cushman if you can find a direct address. Frame it as:

1. **Preservation**: You want to ensure the scanned PDFs survive independent of Harvard's hosting decisions, using IPFS for content-addressed distributed storage.
2. **Public access**: You're building an open, serverless search index that links back to their data and to CourtListener, keeping attribution front and center.
3. **Alignment**: Their stated mission is making law freely accessible. You're extending that mission to permanent, decentralized availability. Greg Leppert's IDI work with Filecoin Foundation shows they already value this approach.
4. **Practical offer**: Ship them a hard drive, pay for transfer, accept whatever format they have. Make it as low-friction as possible for them.
5. **Not commercial**: This is a public-good infrastructure project, not a commercial product built on their data.

Keep it short. These are busy academics. Lead with what you're offering (preservation, free infrastructure), not what you need.

### If the Lab Is Unresponsive

- Try Greg Leppert directly via Berkman Klein; he's the most technically aligned with the IPFS approach.
- Reach out to Mike Lissner at Free Law Project / CourtListener. He collaborated with Harvard on the data and may have his own copy of the PDFs, or know who does.
- Check if the Internet Archive has a copy. They often mirror large public domain datasets.
- File a records request with Harvard Law Library for the public domain dataset. This is a long shot but establishes a paper trail.

---

## Risk Assessment

**Harvard takes case.law offline**: This is the primary risk and the reason to act now. The API is already dead, search is already dead. Bulk data and PDF hosting could be next.

**CourtListener changes bulk data format or access**: Low risk in the near term. They're a stable nonprofit with a decade of operations. But formats change; pin a copy of each quarterly dump.

**IPFS pinning ecosystem**: If you're the only pinner, the data is only as available as your own storage's uptime. Mitigate by seeding to Filecoin storage deals (cheap for public domain data) and encouraging academic institutions to pin.

**Ravel/LexisNexis claims**: The original Ravel exclusivity deal expired in March 2024. The data is public domain case law. The scans themselves may have a thin copyright claim (sweat of the brow for digitization), but Harvard released them under CC0 / no known copyright restrictions. This is clean.

---

## Summary

| Component | Source | Size | Hosting | Monthly Cost |
|---|---|---|---|---|
| RoaringBuckets index | Built from merged data | ~1-5 GB | R2 | ~$0.08 |
| Full text corpus | Harvard HF + CourtListener CSV | 80-324 GB | R2 | $1.20-$4.86 |
| Reporter volume PDFs | case.law scrape or bulk transfer | 400 GB - 2 TB | IPFS (own pin) | $0 |
| **Total R2** | | | | **< $5/month** |

Act on the PDFs first. Everything else can wait.
