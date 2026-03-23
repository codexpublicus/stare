# Mirroring static.case.law

## Site Structure

`https://static.case.law/` serves plain HTML directory listings via Cloudflare (no JS rendering). It contains ~40,622 volumes across hundreds of reporter series (a2d, alaska, cal, f2d, us, etc.).

### Root-level metadata files

| File | Description |
|------|-------------|
| `ReportersMetadata.json` | All reporter series metadata |
| `VolumesMetadata.json` | All 40,622 volumes with publisher, year, jurisdictions, Harvard HOLLIS IDs |
| `JurisdictionsMetadata.json` | Jurisdiction list |

### Per-reporter directory (e.g., `/a2d/`)

Each reporter directory lists its volumes and provides per-volume downloadable files:

| File | Example Size (a2d/31) | Contents |
|------|----------------------|----------|
| `{vol}.tar` | 97 MB | **Complete raw digitization archive**: ALTO OCR XML (gzipped), page images (JP2), METS structural metadata, casemets XML. ~3,675 files per volume. This is the archival gold — contains everything needed to reconstruct all other formats. |
| `{vol}.pdf` | 11.6 MB | Full volume PDF — the complete scanned reporter book. Irreplaceable preservation copy. |
| `{vol}.zip` | 413 KB | Per-case extracted JSON + HTML + VolumeMetadata.json + CasesMetadata.json. Derivable from the tar. |
| `{vol}.tar.csv` | small | Tar manifest: `path,offset,size` for every file in the tar. Enables random-access reads without extracting. |
| `{vol}.tar.sha256` | small | SHA-256 checksum of the tar file. |

### Per-volume browsable directory (e.g., `/a2d/31/`)

Each volume also has a browsable directory structure:

```
/a2d/31/
  cases/          — per-case JSON files (same content as the zip)
  case-pdfs/      — per-case PDFs extracted from the volume (100-600 KB each)
  html/           — rendered HTML per case
  VolumeMetadata.json
  CasesMetadata.json
```

These per-case files are **derivable** from the tar/pdf and would massively multiply request count. Skipped for initial mirror.

### Per-case JSON structure

Each case JSON (e.g., `/a2d/31/cases/0647-01.json`) contains:
- Case ID, name, decision date, docket number
- First/last page references
- Official citations
- Court and jurisdiction metadata
- `cites_to` array with cross-references to other cases
- Full opinion text (in the `casebody` field)

## Size Estimates

| What | Per Volume (avg) | Total (40,622 vols) |
|------|-----------------|---------------------|
| Tars | ~97 MB | **~3.9 TB** |
| Volume PDFs | ~12 MB | **~488 GB** |
| Zips | ~413 KB | **~17 GB** |
| tar.csv + tar.sha256 | ~few KB | negligible |
| **Total (without browsable dirs)** | | **~4.4 TB** |

## What We're Mirroring

Everything except browsable per-case directories:
- `*.tar` — raw digitization archives (ALTO, images, METS)
- `*.pdf` — full volume scans
- `*.zip` — extracted case text
- `*.tar.csv` — tar manifests
- `*.tar.sha256` — checksums
- Root metadata JSONs (3 files)

**Total: 203,113 URLs** (40,622 volumes x 5 file types + 3 metadata JSONs)

## Implementation

### Architecture

```
docker compose (mirror/docker-compose.yaml)
  └─ codex-mirror container (hurlenko/aria2-ariang)
       ├─ aria2c daemon — downloads 10 concurrent files
       ├─ AriaNg web UI — progress monitoring at http://ml-01:8280/
       └─ NFS volume → truenas:/mnt/mega/codex-publicus
```

### Queue / Resume System

aria2's `--save-session` acts as a shrinking queue:
1. **First run**: `init-input.sh` symlinks the full URL list (`urls-aria2.txt`, 203K URLs) as the input file
2. **During download**: `--save-session` periodically writes only incomplete/errored downloads to `session.txt` on NFS
3. **On restart**: `init-input.sh` detects `session.txt` exists and symlinks it as input instead — only remaining work is queued
4. **No HEAD requests** on resume — purely file-based state tracking

### Files

| File | Purpose |
|------|---------|
| `mirror/docker-compose.yaml` | Docker compose with NFS volume mount |
| `mirror/aria2.conf` | aria2 config (concurrency, user-agent, session paths) |
| `mirror/init-input.sh` | Entrypoint wrapper: picks session file or full URL list |
| `mirror/urls.txt` | Plain URL list (one per line, 203K URLs) |
| `mirror/urls-aria2.txt` | aria2 input format with `out=` directives for path mapping |

### Key Configuration

```
max-concurrent-downloads=10
max-connection-per-server=4
split=4
min-split-size=20M
user-agent=codex-publicus-mirror/1.0 (preservation project; contact: @lokkju)
conditional-get=true
```

### Storage

- **Target**: TrueNAS at `truenas.lodenheim.lokkju.com`
- **Dataset**: `mega/codex-publicus`
- **NFS export**: `/mnt/mega/codex-publicus` to `192.168.32.0/24` (MapRoot: root)
- **Docker NFS volume**: mounted directly via `driver_opts` in compose — no host mount needed
- **Download path**: `/aria2/data/downloads/{reporter}/{volume}.{ext}`

### Running

```bash
cd mirror/

# Start (first run or resume)
docker compose up -d

# Watch logs
docker logs -f codex-mirror

# Web UI
open http://ml-01:8280/

# Stop gracefully (saves session for resume)
docker compose down

# Check download progress
docker exec codex-mirror ls /aria2/data/downloads/ | wc -l

# Reset and start fresh (deletes session file)
docker exec codex-mirror rm -f /aria2/data/session.txt
docker compose restart
```

## Post-Download Verification (TODO)

After the mirror completes:

1. **Verify tar checksums**: Compare each `{vol}.tar.sha256` against the downloaded tar (`sha256sum -c`)
2. **Count completeness**: Compare downloaded reporter/volume combinations against `VolumesMetadata.json` — ensure all 40,622 volumes have all 5 file types
3. **Spot-check PDFs**: Verify a sample of PDFs are valid (not truncated/corrupt)
4. **Last-pass re-download with checksumming**: Re-request files with checksum validation to catch any corruption from the initial transfer (network errors, NFS issues, etc.)
