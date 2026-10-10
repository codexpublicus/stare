# CourtListener mirror

Issues: [#83](https://github.com/codexpublicus/stare/issues/83) (mirror the bulk export),
[#84](https://github.com/codexpublicus/stare/issues/84) (take each export as a delta),
[#8](https://github.com/codexpublicus/stare/issues/8) (case sources beyond CAP).

This replaces the "CourtListener Integration (Phase 2)" sketch in `search-plan.md` and Phase 7 of
`checklist.md` for case text. The citation graph (`citation-map`) is out of scope here; it gets
its own plan once search exists.

## What CourtListener publishes

Free Law Project's bulk export lives in the public S3 bucket `com-courtlistener-storage` under
`bulk-data/`, fetched over plain HTTPS with no token. As of 2026-10-10 the newest complete export
is 2026-09-30:

| Table | bz2 size | What stare takes from it |
|---|---|---|
| `opinions` | 55.3 GB | opinion text, type, author, `cluster_id` |
| `dockets` | 5.1 GB | court, docket number, case name fallback |
| `opinion-clusters` | 2.5 GB | case name, date filed, status, `blocked`, `docket_id` |
| `citations` | 0.13 GB | `volume`, `reporter`, `page`, `type` per cluster |
| `courts` | < 1 MB | court and jurisdiction names |

Exports were monthly through 2025 and are quarterly in 2026 (03-31, 06-30, 09-30). Tables for one
date can land hours apart, and the 2024-03-01 set is 14-byte placeholders, so a reader picks the
newest date where every table it needs is present and at least 1 MB.

The CSV is PostgreSQL `COPY ... WITH (FORMAT csv, ESCAPE '\')` output: quotes and backslashes are
escaped with a backslash, not doubled, and fields run past 750 KB. Python's `csv` reads it with
`escapechar="\\"`, `doublequote=False` and a raised field size limit; the defaults split rows.

The bulk-data page states: "Our bulk data files are free of known copyright restrictions," with the
Creative Commons Public Domain Mark 1.0. The fetch step records that statement, its URL and the
date checked in each export's `export.json`.

## Which cases stare takes

CourtListener re-imported most of CAP, so most of its clusters are cases stare already holds.
CAP stays the text of record wherever it holds a case: it has the page scans, ALTO and page
numbers the viewer is built on. CourtListener contributes:

- **Cases CAP doesn't hold**, reachable by a reporter citation: everything after 2018, plus
  reporters and pages CAP never scanned or released (for example the redacted regional reprints
  in [#61](https://github.com/codexpublicus/stare/issues/61) and
  [#143](https://github.com/codexpublicus/stare/issues/143)).
- **Crosswalk ids** on CAP cases it shares: cluster, docket and opinion ids, recorded against
  the CAP case so later work (the citation graph, [#10](https://github.com/codexpublicus/stare/issues/10)'s
  court record key) can join on them.

A cluster is "held by CAP" when any of its citations falls on a page CAP's index resolves. A
cluster with no reporter citation at all can't be reached by the resolver; those wait for search.

Sizing for 2026-09-30 (`opinion-clusters` joined to `citations`, against index v2026.10.05):

| Clusters | Count |
|---|---|
| All | 10,174,551 |
| Blocked (`blocked = t`), never published | 825,839 |
| With a citation in a volume stare holds from CAP | 7,160,260 |
| With no citation at all | 1,860,920 |
| **With citations, none in a volume stare holds** | **327,532** |
| of which decided 2019 or later | 145,815 |
| of which CourtListener got from Harvard (`filepath_json_harvard` set) | 58,732 |

The new cases are mostly reporters CAP never had: `NY Slip Op` (70,128), Ohio's neutral citation
(60,923), the Tax Court memorandum series (`T.C.M.`, `T.C. Memo.`, about 26,000 each), `N.Y.S.3d`
(20,484), `Ct. Cl.` (19,406), `A.D.3d` (18,947), `F.4th` (12,935) and `P.3d` (9,396). Only 2,195
are `A.3d`: CourtListener has few West regional citations for recent state cases, so much of the
post-2018 material is reachable only by neutral or slip-opinion citations.

The count is per volume, not per page, so it misses cases CourtListener holds on pages CAP left
out of a volume it otherwise has (the redacted reprints); the stage step counts those per page.

## The record

There is no common record type yet; the viewer reads CAP's case JSON (`crates/stare/src/case.rs`,
`CaseJson`). A CourtListener record uses the same shape, so the viewer renders both with one code
path, and adds a `source` block. CAP records get `source: {"name": "cap"}` implied when absent.

```json
{
  "id": 9876543,
  "name": "Smith v. Jones",
  "name_abbreviation": "Smith v. Jones",
  "decision_date": "2021-04-02",
  "citations": [{"type": "official", "cite": "245 A.3d 1012"}],
  "court": {"name": "Supreme Court of Pennsylvania"},
  "jurisdiction": {"name_long": "Pennsylvania"},
  "casebody": {"opinions": [{"type": "majority", "author": "Saylor", "text": "..."}]},
  "source": {
    "name": "courtlistener",
    "export": "2026-09-30",
    "first_seen": "2026-09-30",
    "ids": {"cluster": 9876543, "docket": 6543210, "opinions": [11111, 11112]},
    "docket_number": "J-12-2021",
    "precedential_status": "Published",
    "text_field": "html_with_citations",
    "url": "https://www.courtlistener.com/opinion/9876543/smith-v-jones/"
  }
}
```

- `id` is the cluster id. CAP ids and CourtListener cluster ids overlap numerically, so a reader
  keys on `(source.name, id)`, never `id` alone.
- `type` maps CourtListener's opinion types (`010combined`, `020lead`, `030concurrence`,
  `040dissent`, ...) onto CAP's (`majority`, `concurrence`, `dissent`, ...); the original value
  stays in the mapping table, not the record.
- `text` comes from the first non-empty field in this order: `html_with_citations`,
  `html_columbia`, `html_lawbox`, `xml_harvard`, `html`, `html_anon_2020`, `plain_text`. HTML is
  converted to text with paragraph breaks kept; CourtListener's own citation anchors are dropped,
  since stare links citations itself. `source.text_field` says which field it was.
- `citations` lists every citation the cluster has, typed with CAP's vocabulary (`official`,
  `parallel`, `vendor`, `neutral`).

## Storage

Records go to the existing data bucket (`codex-data`, served as `data.stare.pub`) under `cl/`:

```
cl/c/<cluster_id>/<hash>.json.gz      one record, immutable, gzip
cl/exports/<date>/manifest.ndjson.gz  every live cluster id → hash for that export
cl/exports/<date>/delta.json          added / changed / removed ids against the previous export
cl/exports/<date>/export.json         the source tables' keys, sizes, ETags, sha256 and terms
```

`<hash>` is the first 16 hex digits of the sha256 of the record's canonical JSON (sorted keys,
no `source.export`/`first_seen`, so an unchanged case hashes the same in every export). One object
per case, rather than CAP-style volume zips, is what makes
[#84](https://github.com/codexpublicus/stare/issues/84) fall out of the layout: a new export uploads
only the cases whose hash changed, an offline mirror ([#23](https://github.com/codexpublicus/stare/issues/23))
fetches only those, and the browser downloads one case instead of a volume. This is D29 in the
session's decision queue; per-volume zips are the alternative, at the cost of rewriting a whole
volume for one corrected case.

## Index

The CAP index (`v/<ver>/<reporter>/<vol>.bin` and `.multi`) maps a page to a CAP case file. A
CourtListener volume gets a sidecar in the same version directory:

```
v/<ver>/<reporter>/<vol>.cl     text lines: page,cluster_id,hash
```

The resolver reads `.bin`/`.multi` first. If CAP has no case at the page (or doesn't hold the
volume), it reads `.cl` and fetches `data.stare.pub/cl/c/<cluster_id>/<hash>.json.gz`. The root
manifest gains `cl: {export, reporters: {slug: [vols]}}` so `checkAvailability` knows which
volumes have a sidecar, and a reader that doesn't know the key ignores it.

`<reporter>` is the CAP slug where CAP has the reporter. Reporters CAP never had (neutral
citations such as `2021 IL 125678`, `S. Ct.` after CAP's last volume, `F.4th`, Westlaw numbers)
take citare's reporter key, slugged the same way; citare's resolvable citations then need a slug
for every reporter, not only Harvard's, which is a citare change.

Rebuilding a volume's `.cl` only when one of its clusters changed is the index half of #84. The
`.cl` files are small enough (one line per case) that the first version regenerates all of them
each export and uploads only those whose bytes changed.

## Pipeline

`pipelines/courtlistener/` (uv project, CLI `stare-cl`), run on ml-01 in a container like
`index-build`, against the `codexpublicus-courtlistener` volume (`/mnt/mega/codexpublicus/courtlistener`
on TrueNAS):

1. **fetch** (`stare-cl fetch`): newest complete export, resumable with `If-Range` against the
   ETag, sha256 and terms recorded in `export.json`. Lifted from gorsuch-library's `clbulk`.
2. **stage**: load `courts`, `dockets` (selected columns), `opinion-clusters` and `citations` into
   one SQLite or DuckDB file; mark each cluster held-by-CAP or not using the index's manifest and
   `.bin` files.
3. **text**: stream `opinions` once (lbzip2 in parallel; the bz2 decode is the slow part, about
   300 GB uncompressed), keeping only opinions of selected clusters, spooled by cluster id.
4. **records**: emit one record per selected cluster, hash it, and compare against the previous
   export's manifest to produce `manifest.ndjson.gz` and `delta.json`.
5. **index**: write the `.cl` sidecars and the manifest's `cl` block into the next index version.
6. **publish**: operator-run, like `index-publish`: upload new objects, then the export manifests,
   then the index version. Removed or blocked clusters are deleted from the bucket, not only
   dropped from the index.

`date_modified` doesn't let the pipeline skip work: every export still has to decompress all of
`opinions` to find the changed rows, and hashing is cheap next to the bz2 decode. Hashes decide
what changed; `date_modified` is kept only as a diagnostic.

A cluster merged into another on CourtListener's side disappears from the export and its
citations move to the surviving cluster. The delta records it as removed, and the citation
resolves to the survivor through the rebuilt `.cl`. An alias record is only needed if something
links to cluster ids directly, which nothing in stare does yet.

## Slices

1. Fetch and read the export (`stare-cl fetch/verify/head`). In review.
2. The record type in `crates/stare` and the viewer path for a `.cl` hit, with a hand-made record
   as the test fixture.
3. stage + text + records on a sample, then on the full export.
4. `.cl` sidecars, the manifest's `cl` block, and citare slugs for non-Harvard reporters.
5. Publish, and the delta against the next export (2026-12-31).
