"""Regenerate ``src/stare_courtlistener/data/cap_reporters.json`` from CAP's reporter list.

    uv run python scripts/cap_reporters.py <ReportersMetadata.json>

``ReportersMetadata.json`` is CAP's list of the reporters it scanned (on static.case.law, and
at the root of the CAP mirror). The packaged copy keeps each reporter's slug, short name and
jurisdictions' long names: the slug is the index's reporter directory, the short name is how
a citation spells the reporter, and the long names are CAP's jurisdiction vocabulary.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = (
    Path(__file__).resolve().parent.parent / "src" / "stare_courtlistener" / "data"
) / "cap_reporters.json"


def main(path: str) -> None:
    reporters = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = sorted(
        (
            {
                "slug": r["slug"],
                "short_name": r["short_name"],
                "jurisdictions": sorted({j["name_long"] for j in r["jurisdictions"]}),
            }
            for r in reporters
        ),
        key=lambda r: r["slug"],
    )
    text = "[\n" + ",\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n"
    OUT.write_text(text, encoding="utf-8")
    print(f"{len(rows)} reporters -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1])
