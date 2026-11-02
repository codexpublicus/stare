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
with scores, and the first 20 cards. `web/scripts/search-expected.mjs` writes it, given
that client directory with roaringbuckets' client linked in as
`node_modules/@roaringbuckets/client`. `web/tests/searchclient.test.js` runs stare's
vendored copy on the same queries and compares; `web/e2e/search.spec.js` serves the tree
through routes, so the browser tests need no R2. Rebuild both when the client's pin moves.

`searchtree.js` answers the tree's files as idx.stare.pub does (single and multi-range
206s) for both.

# Collection fixtures

`collection/` holds index build v2026.10.26.2's `manifest.json`, `report.json` and
`search/facets.json` from idx.stare.pub, trimmed to the fields `collectionFromIndex`
(`web/src/lib/collection-read.js`) reads, for `web/tests/collection.test.js`.
