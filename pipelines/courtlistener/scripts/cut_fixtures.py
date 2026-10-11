"""Cut the test fixtures in tests/fixtures/ from decompressed samples of a real export.

    uv run python scripts/cut_fixtures.py <sample dir> [<date>]

The sample directory holds ``<table>.csv`` for each table: the head of one export,
decompressed (the last line may be cut off). Each fixture keeps the header, the first
three records, and the first record showing each feature the reader must get right (an
escaped quote, an escaped backslash, an embedded newline, a carriage return, a null, an
empty string), with any value over ``MAX_FIELD`` characters cut down (but not before its
first backslash). Records are written back in the export's own form (every non-null value
quoted, ``\\"`` and ``\\\\`` escapes, null as an empty unquoted field), checked against the
sample's bytes as it goes.
"""

from __future__ import annotations

import csv
import io
import sys
from pathlib import Path

from stare_courtlistener.table import FIELD_SIZE_LIMIT, ExportDialect

TABLES = ("opinion-clusters", "opinions", "dockets", "citations", "citation-map")
MAX_FIELD = 4000
FEATURES = {
    "quote": lambda v: '"' in v,
    "backslash": lambda v: "\\" in v,
    "newline": lambda v: "\n" in v,
    "carriage return": lambda v: "\r" in v,
}
FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def serialize(row: list[str | None]) -> str:
    """One record as PostgreSQL ``COPY ... CSV`` with ``ESCAPE '\\'`` writes it."""
    fields = (
        "" if v is None else '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"' for v in row
    )
    return ",".join(fields) + "\n"


def shorten(value: str | None) -> str | None:
    """A value cut to ``MAX_FIELD`` characters, or just past its first backslash."""
    if value is None:
        return None
    limit = MAX_FIELD
    if "\\" in value:
        limit = max(limit, value.index("\\") + 100)
    return value[:limit]


def cut(sample: Path, table: str, export: str) -> tuple[Path, list[str]]:
    csv.field_size_limit(FIELD_SIZE_LIMIT)
    with sample.open(encoding="utf-8", newline="") as fh:
        raw = fh.read()
    header_line = raw[: raw.index("\n") + 1]
    reader = csv.reader(io.StringIO(raw[len(header_line) :], newline=""), dialect=ExportDialect)
    picked: list[list[str | None]] = []
    why: list[str] = []
    wanted = {**FEATURES, "null": None, "empty string": None}
    offset = len(header_line)
    try:
        for n, row in enumerate(reader):
            line = serialize(row)
            if raw[offset : offset + len(line)] != line:
                if "\n" not in raw[offset:]:
                    break  # the sample's last record is cut off
                raise SystemExit(f"{table}: record {n + 1} doesn't serialize back to its bytes")
            offset += len(line)
            hits = []
            for name, test in list(wanted.items()):
                if name == "null":
                    found = any(v is None for v in row)
                elif name == "empty string":
                    found = any(v == "" for v in row)
                else:
                    found = any(v is not None and test(v) for v in row)
                if found:
                    hits.append(name)
                    del wanted[name]
            if n < 3 or hits:
                picked.append(row)
                why.append(f"record {n + 1}: " + (", ".join(hits) or "head"))
            if not wanted and n >= 3:
                break
    except csv.Error:
        pass  # the sample's last record is cut off
    out = FIXTURES / f"{table}-{export}.csv"
    with out.open("w", encoding="utf-8", newline="") as fh:
        fh.write(header_line)
        for row in picked:
            cut_row = [shorten(v) for v in row]
            fh.write(serialize(cut_row))
    return out, why


def main() -> None:
    sample_dir = Path(sys.argv[1])
    export = sys.argv[2] if len(sys.argv) > 2 else "2026-09-30"
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for table in TABLES:
        out, why = cut(sample_dir / f"{table}.csv", table, export)
        print(f"{out.name}: {out.stat().st_size} bytes; {'; '.join(why)}")


if __name__ == "__main__":
    main()
