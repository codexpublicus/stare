# Search fixtures

`search-tree/v/v2026.10.26/search/` is a full-text search tree in stare-builder's format 2
(its `docs/search-index.md`), built from the made-up corpus in stare-builder's
`pipelines/search-index/tests/fixture.py`: 149 decisions in three CAP volumes and a
CourtListener volume, with the tiers made small (h 4, m 8, m2 to 20) so its words land in
every tier, and the segments made small (1,000 bytes: 25 cards segments of six cards each,
and six low segments that term parts straddle), as stare-builder's own tests build it
(`tests/conftest.py`). It was built at stare-builder d419b9eb2754b6f124d14bad0eab874c03c962e9
with:

```python
import sys
from pathlib import Path

import pytest
from stare_search import cli, fmt
from tests.fixture import make_corpus

root = Path(sys.argv[1])
c = make_corpus(root / "src")
mp = pytest.MonkeyPatch()
mp.setattr(fmt, "TIER_H", 4)
mp.setattr(fmt, "TIER_M", 8)
mp.setattr(fmt, "TIER_M2_END", 20)
mp.setattr(fmt, "SEGMENT_BYTES", 1000)
work, out = root / "work", root / "out" / "v" / "v2026.10.26" / "search"
cli.main(["extract", "--mirror", str(c["mirror"]), "--work", str(work),
          "--cl-export", str(c["cl_export"]), "--cl-records", str(c["cl_records"]), "--jobs", "2"])
cli.main(["build", "--work", str(work), "--out", str(out), "--index", str(c["index"]),
          "--mirror", str(c["mirror"]), "--courts", str(c["courts"]),
          "--cap-courts", str(c["cap_courts"]), "--version", "v2026.10.26",
          "--cl-export-date", "2026-09-30", "--jobs", "2"])
```

run with `uv run python` from `pipelines/search-index/` (on `sys.path`, for `tests`).

`search-expected.json` is what stare-builder's own client at that commit returned for each
query in `search-queries.json` on the tree: the totals, stage and flags, the whole ranking
with scores, and the first 20 cards.

`search-tree-format3/v/v2026.10.26/search/` is the same corpus in format 3, built at
stare-builder 6098a43072a3366c4c8c90e6a63553f59b7addd0 (stare-builder#90) with the script
above plus the citation counts step, run between `extract` and `build`:

```python
cli.main(["citations", "--work", str(work), "--cl-clusters", str(c["cl_clusters"]),
          "--cl-crosswalk", str(c["cl_crosswalk"]), "--jobs", "2"])
```

as stare-builder's `tests/conftest.py` does at that commit. The corpus there gains
CourtListener's opinion-clusters table and the export's crosswalk: ny/1/0013-02, Palsgraf v.
Elevator Co., is cited 5,000 times and ny/1/0001-01 700. `search-expected-format3.json` is
that commit's client on `search-queries-format3.json`, format 2's queries plus three party
names (`palsgraf elevator`, `Palsgraf v. Elevator Co.`, `jones kale`).

`web/scripts/search-expected.mjs` writes both, given a client directory
(`pipelines/search-index/client` at the commit) with roaringbuckets' client linked in as
`node_modules/@roaringbuckets/client`, the tree, the queries and the output:

```
node web/scripts/search-expected.mjs <client dir> web/tests/fixtures/search-tree-format3 \
  web/tests/fixtures/search-queries-format3.json web/tests/fixtures/search-expected-format3.json
```

`web/tests/searchclient.test.js` runs stare's vendored copy for each format on its tree and
compares; `web/e2e/search.spec.js` serves the trees through routes, format 2's unless a test
asks for format 3's, so the browser tests need no R2. Rebuild a format's tree and expected
results when its client's pin moves; the format-2 tree and its files go when that client
does (`src/vendor/stare-search-format2/README.md`).

`searchtree.js` answers either tree's files as idx.stare.pub does (single and multi-range
206s) for both test files.

# Collection fixtures

`collection/` holds index build v2026.10.26.2's `manifest.json`, `report.json` and
`search/facets.json` from idx.stare.pub, trimmed to the fields `collectionFromIndex`
(`web/src/lib/collection-read.js`) reads, for `web/tests/collection.test.js`.
