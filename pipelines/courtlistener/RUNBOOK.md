# CourtListener bulk export: runbook

`stare-cl` mirrors CourtListener's bulk export ([stare#83](https://github.com/codexpublicus/stare/issues/83)).
This first slice only fetches and reads it; nothing here loads it anywhere yet.

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
