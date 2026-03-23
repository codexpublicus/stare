# Extraction & Index Plan

## Goal

A near-zero-cost, serverless system to resolve U.S. case law citations to full text and original scanned PDFs. Primary use case: LLM citation validation via MCP server or local tool. Secondary: a public serverless website (stare.pub).

All rendering and PDF generation is client-side (WASM). The server is entirely static files.

## Architecture Overview

```
User input: "31 A.2d 647"
       │
       ▼
┌─────────────────┐
│  Citation Parse  │  eyeCite: reporter="A.2d", vol=31, page=647
│  (eyeCite)       │  reporters.json: "A.2d" → slug "a2d"
└────────┬────────┘
         │
         ▼
┌─────────────────┐     Range request: byte offset = page * ENTRY_SIZE
│  Citation Index  │     GET /index/a2d/31.bin  Range: bytes=5176-5183
│  (R2 / local)   │     → "0647-01"
└────────┬────────┘
         │
         ├──── GET /data/a2d/31.zip         → extract 0647-01.json client-side
         │     (~400 KB, cacheable)            full text + metadata
         │
         └──── GET /data/a2d/31.tar         → range request via tar.csv
               (range request for page         page image + ALTO OCR
                images + ALTO XML)              for viewer / on-demand PDF
```

### Layers

1. **Citation resolution** (this document) — parse citation, look up case file via binary index, fetch text from zip, fetch scans from tar
2. **Search** (future) — RoaringBuckets bitmap indexes for querying by jurisdiction, court, date, case name tokens. Returns case IDs that resolve through layer 1.

### Key Design Principle: No Extraction

The mirrored files (tars, zips, PDFs) are served as-is. No per-case file extraction. This keeps the object count low (~200K vs ~150M+), makes the bucket trivially clonable, and keeps everything cacheable.

- **Zips** (~400 KB each): client fetches whole zip, extracts case JSON locally
- **Tars** (~97 MB each): client uses tar.csv manifest + HTTP range requests to pull individual page images and ALTO XML
- **PDFs** (~12 MB each): volume-level fallback viewer

## R2 Object Layout

```
/index/reporters.json             ← abbreviation → slug mapping (tiny, cache forever)
/index/{reporter}/{vol}.bin       ← citation lookup, 8 bytes/page (cache forever)
/index/{reporter}/{vol}.multi     ← overflow for multi-case pages (tiny, cache forever)
/data/{reporter}/{vol}.zip        ← case text JSONs + HTML + metadata
/data/{reporter}/{vol}.tar        ← page images (JPG) + ALTO OCR XML + structural XML
/data/{reporter}/{vol}.tar.csv    ← byte offset manifest for range requests into tar
/data/{reporter}/{vol}.pdf        ← full volume PDF (fallback)
/data/{reporter}/{vol}.tar.sha256 ← tar checksum
```

**Total objects**: ~203K (40,622 volumes x 5 data files + 40,622 index bins + 3 metadata files)
**Upload cost**: ~$0.90 one-time (Class A operations at $4.50/M)
**Clonability**: anyone can `rclone sync` the entire service in minutes

## Citation Parsing

### eyeCite (from Free Law Project)

Lightweight Python library. Dependencies: `reporters-db`, `courts-db`, `lxml`, `regex`, `pyahocorasick`.

**Performance**: 0.15ms per parse (6,600 parses/sec). Negligible overhead.

**What it handles**:
- Standard citations: `31 A.2d 647`, `410 U.S. 113`
- Abbreviation variants: `A.2d`, `A. 2d`, `Atlantic Reporter`
- Parallel citations, short-form citations, supra references
- 1,235 reporter entries in `reporters-db`

**For our first pass**: we're parsing user-provided citation strings, not scanning text for citations. eyeCite handles all the normalization edge cases that a regex would miss, and it's fast enough to be invisible.

**Install**: `uv add eyecite`

## Reporter Slug Mapping

`ReportersMetadata.json` from static.case.law has the mapping:

```json
{"short_name": "A.2d", "slug": "a2d", "id": 210, ...}
```

401 reporters total. Build a static `reporters.json` mapping abbreviation → slug. eyeCite's `reporters-db` handles variant normalization, so we only need canonical abbreviations.

**Delivery**: small static JSON at `/index/reporters.json`, cached indefinitely.

## Citation Index Format

### Structure: `{reporter}/{vol}.bin`

Each volume gets a small binary file. The page number is a direct array index — no search, no scanning.

```
File: /index/a2d/31.bin

Entry size: 8 bytes (fixed)
Page N → byte offset N * 8
Contents: case filename (e.g., "0647-01"), null-padded to 8 bytes
Empty pages: all null bytes (0x00)
```

**Lookup**: one HTTP range request.

```
GET /index/a2d/31.bin
Range: bytes=5176-5183      (647 * 8 = 5176)
→ "0647-01\0"
```

### Entry size: 8 bytes

All case filenames across the corpus are exactly 7 characters (`PPPP-NN`): 4-digit zero-padded page + hyphen + 2-digit sequence. Verified across a2d, f2d, us, cal.

8 bytes = 7 chars + null terminator.

### Volume sizes

| Volume | Max Page | Index Size |
|--------|----------|-----------|
| a2d/31 | 894 | 7.0 KB |
| f2d/2 | 1023 | 8.0 KB |
| us/3 | 515 | 4.0 KB |

Estimated total corpus index: ~40 MB.

### Multi-case pages

Some pages have multiple cases (e.g., page 657 has `0647-01` and `0657-02`). Frequency:

| Reporter | Multi-case pages per volume |
|----------|---------------------------|
| a2d | ~1 (rare) |
| f2d | ~11-26 (common) |
| us | ~47-50 (very common) |
| cal | ~0-5 |

**Solution**: bin entry holds `-01` case. A small `.multi` sidecar file lists overflow entries:

```
/index/a2d/31.bin      ← page → first case (direct offset)
/index/a2d/31.multi    ← page,case_id pairs for -02, -03 entries (tiny)
```

For citation validation (primary use case), `-01` is almost always correct. The `.multi` file is only needed for exhaustive results.

## Text Access

### From the zip files

Each zip (~400 KB) contains:
- `json/{case_id}.json` — per-case JSON with full text, citations, metadata
- `html/{case_id}.html` — rendered HTML
- `metadata/CasesMetadata.json` — case listing with page mappings
- `metadata/VolumeMetadata.json` — volume info

**Client flow**: fetch the whole zip (cacheable), extract the needed JSON client-side. For an MCP server processing multiple citations from the same volume, one fetch serves all of them.

### Case JSON structure

```json
{
  "id": 8152382,
  "name": "D'ELIA & MARKS CO., Inc., v. LYON",
  "name_abbreviation": "D'Elia & Marks Co. v. Lyon",
  "decision_date": "1943-05-11",
  "citations": [{"type": "official", "cite": "31 A.2d 647"}],
  "court": {"name": "District of Columbia Municipal Court of Appeals"},
  "jurisdiction": {"name_long": "District of Columbia"},
  "cites_to": [...],
  "casebody": {
    "judges": [...],
    "parties": [...],
    "opinions": [{"text": "...", "type": "majority", "author": "HOOD, Associate Judge"}],
    "attorneys": [...],
    "head_matter": "..."
  }
}
```

## Page Image & OCR Access

### From the tar files via range requests

Each tar (~97 MB) contains per-page:
- **JPG images** (~2,229 per volume, ~91 MB total): original page scans
- **ALTO XML** (~1,115 per volume, ~2.5 MB total): per-page OCR with word/line bounding boxes, font info, confidence scores
- **CASEMETS XML** (~326 per volume): maps cases to their pages, contains casebody with `pgmap` attributes
- **BOXES XML**: bounding box coordinates
- **METS XML**: structural metadata

**Client flow for page viewing**:
1. Fetch `tar.csv` manifest (cacheable)
2. Find byte offset for desired page image + ALTO XML
3. Range request into the tar for the JPG (~40 KB per page)
4. Range request for the ALTO XML (~2 KB gzipped per page)
5. Render: overlay positioned text on page image

### ALTO structure

Per-page XML with pixel-level coordinates for every word:

```xml
<TextLine HEIGHT="41" HPOS="264" VPOS="283" WIDTH="746">
  <String CONTENT="was" HPOS="264" VPOS="300" WIDTH="62" HEIGHT="19" WC="0.75"/>
  <String CONTENT="not" HPOS="344" VPOS="294" WIDTH="53" HEIGHT="24" WC="0.76"/>
  <String CONTENT="only" HPOS="416" VPOS="288" WIDTH="69" HEIGHT="36" WC="0.80"/>
  ...
</TextLine>
```

This enables:
- Text search highlighting at word/line level
- Deep linking to specific passages (case X, page Y, line Z)
- On-demand PDF generation with searchable text layer (via WASM: BentoPDF or similar)
- Accessibility (text overlay on images)

## Client-Side Rendering (WASM)

All rendering runs client-side. The server serves only static files.

- **Citation parsing**: eyeCite (Python, or port to Rust/WASM)
- **Zip extraction**: trivial in any language
- **Tar range access**: HTTP range request + offset math
- **ALTO rendering**: parse XML, overlay text on JPG canvas
- **PDF generation**: on-demand via BentoPDF or printpdf WASM module — compose page JPGs with ALTO text layer
- **Search highlighting**: ALTO word coordinates map directly to canvas/SVG overlay positions

Rust is the natural choice for the WASM stack: fast XML parsing (`quick-xml`), PDF generation (`printpdf`), image handling, and excellent WASM tooling.

## Data Pipeline

### Input (from mirror — already running)

```
/mnt/mega/codex-publicus/downloads/
  {reporter}/{vol}.tar        ← raw digitization (ALTO, JPG, METS, CASEMETS)
  {reporter}/{vol}.pdf        ← full volume PDF
  {reporter}/{vol}.zip        ← per-case JSON + HTML + metadata
  {reporter}/{vol}.tar.csv    ← tar manifest with byte offsets
  {reporter}/{vol}.tar.sha256 ← tar checksum
```

### Build steps

**Step 1: Reporter mapping**

Parse `ReportersMetadata.json` → build `/index/reporters.json`

**Step 2: Citation index**

For each volume zip:
1. Read `metadata/CasesMetadata.json` — list of cases with `file_name` and `first_page`
2. Build `{reporter}/{vol}.bin` — write 8-byte entries at page offsets
3. Build `{reporter}/{vol}.multi` — if any pages have multiple cases

**Step 3: Upload to R2**

Sync to R2:
- `/index/` — reporter mapping + citation bins (~40 MB)
- `/data/` — mirrored files as-is (tars, zips, PDFs, tar.csvs, tar.sha256s)

No extraction, no transformation of the mirrored data. Upload the mirror directly.

## Hosting

### Storage backend

Paths are relative — the system is backend-agnostic. Works against R2, S3, local filesystem, IPFS gateway, or even static.case.law directly.

### R2 bucket layout

One bucket per media type:
- `codex-index` — citation index bins + reporter mapping (~40 MB)
- `codex-data` — mirrored tars, zips, PDFs (~4.4 TB)

### Cost estimate

| Component | Backend | Objects | Size | Cost/month |
|-----------|---------|---------|------|-----------|
| Citation index | R2 | ~41K | ~40 MB | ~$0.001 |
| Zips (case text) | R2 | ~41K | ~17 GB | ~$0.26 |
| Volume PDFs | R2 or IPFS | ~41K | ~488 GB | $0-$7.32 |
| Tars (images + ALTO) | IPFS | ~41K | ~3.9 TB | $0 |
| tar.csv manifests | R2 | ~41K | small | ~$0 |
| **Total** | | ~203K | ~4.4 TB | **< $1 - $8/month** |

R2: no egress fees. Operations: $0.36/M Class B reads.

### Storage split: R2 + IPFS

The tars (~3.9 TB) are the perfect IPFS candidate: large, static, immutable, public domain. Pin from homelab TrueNAS at zero cost. Available via any IPFS gateway.

Everything needed for citation → text resolution lives on R2 (index + zips = ~17 GB, < $0.30/month). The tars on IPFS are only accessed for the page viewer / on-demand PDF features.

| Tier | R2 | IPFS | Cost/month | Capabilities |
|------|-----|------|-----------|-------------|
| **Minimal** | Index + zips | — | ~$0.30 | Citation → text |
| **Standard** | Index + zips + volume PDFs | — | ~$7.60 | Citation → text + volume PDF |
| **Full** | Index + zips + tar.csvs | Tars + volume PDFs | < $1 | Citation → text + page viewer + on-demand PDF |

The full tier at < $1/month is the target: R2 for the small/hot data, IPFS for the bulk scans.

### IPFS / BitTorrent

- **IPFS**: content-addressed, pinned from homelab TrueNAS. Per-reporter directory DAGs for bulk pinning. WASM clients can access IPFS directly (via Helia/js-ipfs) or through any public gateway.
- **BitTorrent**: per-reporter torrents for bulk distribution. Community can seed. Lower barrier than IPFS pinning.
- Both are complementary — IPFS for permanent addressing, BitTorrent for fast bulk transfer.
- Architecture is backend-agnostic — the base URL is configurable per component.

## Client Interfaces

### MCP Server (LLM citation validation)

```
Tool: resolve_citation
Input:  { citation: "31 A.2d 647" }
Output: {
  case_name: "D'Elia & Marks Co. v. Lyon",
  citation: "31 A.2d 647",
  decision_date: "1943-05-11",
  court: "District of Columbia Municipal Court of Appeals",
  text_url: "https://r2.stare.pub/data/a2d/31.zip",
  pdf_url: "https://r2.stare.pub/data/a2d/31.pdf",
  case_file: "0647-01",
  text: "..."
}
```

### Local CLI tool

```bash
# Download California reporters (just index + zips for text)
stare download --reporters cal,cal-2d,cal-3d,cal-4th,cal-5th,cal-app

# Resolve a citation
stare resolve "31 Cal.App.4th 647"
```

### Serverless website (stare.pub)

Static JS/WASM app on Cloudflare Pages:
- Citation input box
- Fetches reporter mapping (cached)
- Range request to citation index
- Fetches zip, extracts case JSON, displays text
- Page viewer: range requests into tar for JPG + ALTO, renders with text overlay
- Download as PDF: WASM PDF generation from JPG + ALTO

## Next Steps

1. Build the reporter mapping from `ReportersMetadata.json`
2. Write the index builder (read CasesMetadata.json from zips → .bin files)
3. Test citation resolution end-to-end with a few volumes
4. Build the MCP server prototype
5. Upload index + subset of data to R2 for testing
6. Build the WASM page viewer prototype
