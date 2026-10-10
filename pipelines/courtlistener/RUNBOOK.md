# CourtListener bulk export: runbook

`stare-cl` mirrors CourtListener's bulk export ([stare#83](https://github.com/codexpublicus/stare/issues/83)).
It fetches and reads the export, then turns it into per-case records on local disk;
nothing here uploads anything yet.

CourtListener publishes its database as dated CSV dumps in the public S3 bucket
`com-courtlistener-storage`, under `bulk-data/`, one `<table>-<YYYY-MM-DD>.csv.bz2` per
table per export. No account or token is needed. In 2026 the export is quarterly: the
bulk-data page says the files are regenerated on the last day of March, June, September
and December, starting at 3 AM Pacific, and generation can take many hours. The tables of
one export land hours apart: on 2026-09-30, dockets was written at 09:03 UTC,
opinion-clusters at 09:40 and opinions at 09:55, but citations not until 20:24 (2026-06-30
had the same pattern). For those eleven hours the date is listed with three of the four
default tables, and `fetch --date latest` still picks the previous quarter. Older dates
are monthly or irregular, and some are placeholders: every table dated 2024-03-01 is a
14-byte file.

Sizes for 2026-09-30, compressed:

| table | size |
|---|---|
| opinions | 55.3 GB |
| dockets | 5.1 GB |
| opinion-clusters | 2.5 GB |
| citations | 127.5 MB |
| **default four** | **63.0 GB** |

`citation-map` (533 MB), `courts` (81 kB) and `people-db-people` (456 kB) can be fetched
too with `--tables`. The last two are real files under the 1 MB placeholder threshold, so
they get their own lower thresholds (`SMALL_TABLES` in `listing.py`).

## Running it

From the repo root, on the host with the disk (ml-01):

```sh
export STARE_CL_DIR=/path/to/courtlistener     # the mirror root; each export gets a <date>/ under it
uv --directory pipelines/courtlistener sync --locked
alias stare-cl='uv --directory pipelines/courtlistener run stare-cl'
```

### List the exports

```sh
stare-cl dates                       # complete exports of the default four tables, newest first
stare-cl dates --all                 # every date, with what each is missing or which are placeholders
stare-cl dates --tables citations    # complete for just these tables
```

A date counts as complete when every requested table is listed at 1 MB or more
(`--min-bytes`). Right after the end of a quarter, expect the new date to show up in
`--all` as incomplete for a while.

### Fetch the latest complete export

```sh
mise run cl-fetch                    # same as: stare-cl fetch --date latest --dest "$STARE_CL_DIR"
mise run cl-fetch --date 2026-09-30 --tables "citations dockets"
```

The files go to `$STARE_CL_DIR/<date>/<table>-<date>.csv.bz2`. Budget about 63 GB of disk
for the default four. The bucket gave a single connection from ml-01 60 to 90 MB/s, which
puts opinions alone at 10 to 15 minutes, plus a few minutes to hash it once it's whole. Progress goes to stderr every 10 seconds.

When it finishes, `<date>/export.json` records, per table, the bucket key, size, ETag,
LastModified, the SHA-256 of the downloaded file and when it was fetched, plus the
bulk-data page's terms statement as it read when last checked (`terms`). The ETags are
S3 multipart ETags (`"…-16"`), not content hashes, so the SHA-256 is the only checksum of
the bytes.

### Resume

Rerun the same command. A finished table (its size matches the listing) is skipped and
keeps its recorded SHA-256 without being re-hashed. An interrupted table is continued from
its `.part` with a `Range` request and `If-Range: <ETag>` (the ETag is kept in
`.part.etag`). If the object was replaced in between, the bucket sends the whole new
object, and the fetch stops with "replaced after the listing was read" instead of
splicing two versions or recording the old ETag beside the new bytes; rerun it. Dropped
connections and 5xx answers are retried eight times per table with backoff doubling from
2 s up to 60 s.

If a rerun says a finished file "was fetched as ETag … but the bucket now lists …",
CourtListener regenerated that export in place. Move the `<date>/` directory aside and
fetch again.

### Verify

```sh
stare-cl verify --date 2026-09-30    # re-hashes every file against export.json; exit 1 on a mismatch
```

### Look at a table

```sh
stare-cl head --table opinions --date 2026-09-30 -n 3            # rows as JSON, long values cut at 200 chars
stare-cl head --table dockets --date 2026-09-30 -n 1 --width 0   # nothing cut
```

`head` decompresses with `lbzip2 -dc` when it's on PATH (every core) and Python's `bz2`
when it isn't. Install `lbzip2` on the host before reading whole tables.

## From an export to records

Three steps turn a fetched export into one record per case
([docs/plans/courtlistener-mirror.md](../../docs/plans/courtlistener-mirror.md), "Pipeline"
steps 2 to 4). Each writes into `<dest>/<date>/` next to the tables and leaves a JSON
report there.

### stage

```sh
stare-cl stage --date 2026-09-30 --index-manifest manifest.json [--index-dir /path/to/v/v2026.10.05]
```

Loads `courts`, `opinion-clusters` and `citations` into `stage.sqlite`, classifies every
cluster, then loads the `dockets` rows of the selected clusters. `--index-manifest` is the
CAP index's root `manifest.json` (`https://idx.stare.pub/manifest.json`); its `reporters`
say which volumes CAP holds. With `--index-dir`, a local copy of that index version (the
directory holding `<slug>/<vol>.bin`), a cluster is held only when one of its citations
lands on a page the index resolves, which catches the pages CAP left out of volumes it
otherwise has.

| class | meaning |
|---|---|
| `blocked` | CourtListener's `blocked` is set; never published |
| `no_citation` | no reporter citation; the resolver can't reach it |
| `cap_held` | a citation is in a CAP volume (or on a CAP page, with `--index-dir`) |
| `selected` | the cases stare takes from CourtListener |
| `docket_blocked` | selected, but its docket is blocked; held back too |

CourtListener reporters are matched to CAP slugs through CAP's `ReportersMetadata.json`
(packaged as `data/cap_reporters.json`; `scripts/cap_reporters.py` regenerates it) on
letters and digits, against the slug and the short name both, with a table of overrides
for spellings that don't fold alike (`Ohio St. (N.S.)` is CAP's `Ohio St.`). Westlaw and
LEXIS citations never match a CAP reporter, and a citation whose volume is a year (`2021 ND
123`, `2004-Ohio-3319`) matches only CAP's one year-numbered reporter. `stage-report.json` has the counts, the selected
clusters' top reporters, and a cross-check against the first sizing's rule (slug against
reporter only) naming the reporters where the two disagree.

On 2026-09-30, clusters and citations took 13 minutes on ml-01 with Python's bz2 (no
`lbzip2`), peaking at 1.6 GB of memory, and left a 3.5 GB `stage.sqlite`; the full `dockets`
table adds one more pass over 5 GB compressed. The database is built as `stage.sqlite.tmp` and
renamed at the end, so a rerun starts over.

### text

```sh
stare-cl text --date 2026-09-30 [--restart]
```

Streams `opinions` (55 GB compressed, about 300 GB of CSV) once and keeps the opinions of the
selected clusters in `text.sqlite`: metadata, the name of the first non-empty text field in
the design's order, and that field's raw value, zlib-compressed. Memory stays flat (one
record at a time plus the selected ids). Progress is committed every 20,000 records; a rerun
after an interruption skips the records already read (it still decompresses and parses them,
so it saves the writes, not the decode). `--restart` throws the progress away, which is
needed after re-running `stage`.

### records

```sh
stare-cl records --date 2026-09-30 [--out DIR] [--previous out/cl/exports/2026-06-30] [--jobs N]
```

Writes, under `--out` (default `<dest>/out`, laid out as the bucket is):

- `cl/c/<cluster_id>/<hash>.json.gz`, one record per selected cluster with opinion text,
  in CAP's case shape plus a `source` block. `<hash>` is the first 16 hex digits of the
  SHA-256 of the canonical JSON without `source.export` and `source.first_seen`, so an
  unchanged case keeps its object across exports. Existing objects are not rewritten.
- `cl/exports/<date>/manifest.ndjson.gz`, one line per record: `id`, `hash`, `first_seen`,
  and the citations with the CAP slugs each may be in.
- `cl/exports/<date>/delta.json`, `added`, `changed` and `removed` ids against
  `--previous` (an earlier export's directory or manifest); without it, all are added.
- `cl/exports/<date>/export.json`, the fetch step's record of the source files.

`first_seen` carries forward from the previous manifest. `records-report.json` in the export
directory has the counts, the record size distribution and the opinion types seen.

## The CSV dialect

The files are PostgreSQL `COPY ... CSV` with `ESCAPE '\'`: every non-null value is quoted, a
null is an empty unquoted field, and a quote or backslash inside a value is escaped with a
backslash (`\"`, `\\`), never doubled. Python's default CSV dialect misreads them, splitting
rows wherever a text column holds an escaped quote. `stare_courtlistener.table` reads them
with that dialect, the field size limit raised (opinions' HTML columns pass 750 KB), and
`QUOTE_NOTNULL`, so a null comes back as `None` and an empty string as `""` (this needs
Python 3.13). Text columns carry raw newlines and the odd `\r\n`
(opinion-cluster 86605's `case_name`). A record of the wrong width, or a file that ends
mid-record, raises an error naming the table, the record and the line.

## Tests

`mise run cl-test` runs ruff and pytest; CI runs the same on the `homelab` runner. The tests
use no network: a fake bucket behind `httpx.MockTransport`, and fixtures in
`tests/fixtures/` cut from the 2026-09-30 export by `scripts/cut_fixtures.py`.
