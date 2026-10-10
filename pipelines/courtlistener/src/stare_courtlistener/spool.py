"""Stream the ``opinions`` table once and keep the opinions of the selected clusters.

``stare-cl text`` reads ``opinions-<date>.csv.bz2`` front to back (through ``lbzip2`` when
it's on PATH; decoding about 300 GB of CSV is the slow part) and writes the opinions of
clusters ``stage`` selected to ``<dest>/<date>/text.sqlite``: the opinion's metadata, which
text field won, and that field's raw value, zlib-compressed. Only the winning field is
kept; the HTML-to-text conversion happens in ``records``, so it can change without another
pass over the table.

The text field is the first non-empty one of ``TEXT_FIELDS``, the order the design gives.

Memory stays bounded: one CSV record at a time, plus the set of selected cluster ids (a few
hundred thousand integers). Progress is committed every ``CHECKPOINT`` records together with
the count read so far, so an interrupted run resumes by skipping that many records. The
skipped records are still decompressed and parsed (bz2 can't seek to a record), so a resume
saves the writes, not the decode; rows are keyed by opinion id, so replaying any of them is
harmless.
"""

from __future__ import annotations

import sqlite3
import zlib
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import TextIO

from stare_courtlistener.stage import STAGE_DB, _logger, connect, table_path
from stare_courtlistener.table import open_table, read_table

TEXT_DB = "text.sqlite"
CHECKPOINT = 20_000

TEXT_FIELDS = (
    "html_with_citations",
    "html_columbia",
    "html_lawbox",
    "xml_harvard",
    "html",
    "html_anon_2020",
    "plain_text",
)
OPINION_COLUMNS = (
    "id",
    "cluster_id",
    "type",
    "author_str",
    "per_curiam",
    "joined_by_str",
    "date_modified",
    *TEXT_FIELDS,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS opinions (
    id INTEGER PRIMARY KEY, cluster_id INTEGER NOT NULL, type TEXT, author_str TEXT,
    per_curiam INTEGER, joined_by_str TEXT, date_modified TEXT, text_field TEXT,
    raw BLOB, raw_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS opinions_cluster ON opinions (cluster_id);
CREATE TABLE IF NOT EXISTS progress (key TEXT PRIMARY KEY, value TEXT);
"""


def pick_text(row: dict[str, str | None]) -> tuple[str | None, str]:
    """The first non-blank text field of an opinion row, and its name (None, "" if none)."""
    for name in TEXT_FIELDS:
        value = row.get(name)
        if value and value.strip():
            return name, value
    return None, ""


def selected_clusters(stage_db: Path) -> set[int]:
    db = connect(stage_db, readonly=True)
    try:
        return {cid for (cid,) in db.execute("SELECT id FROM clusters WHERE class = 'selected'")}
    finally:
        db.close()


def _progress(db: sqlite3.Connection) -> dict[str, str]:
    return dict(db.execute("SELECT key, value FROM progress"))


def spool_text(
    export_dir: Path,
    export: date,
    *,
    out: TextIO | None = None,
    restart: bool = False,
    stop_after: int | None = None,
    on_record: Callable[[int], None] | None = None,
) -> dict[str, int | str]:
    """Fill ``text.sqlite`` from the export's ``opinions``; return counts.

    Args:
        restart: Drop any earlier progress and start from the first record.
        stop_after: Stop after this many records (for tests of the resume path).
        on_record: Called with each record number read (for tests).
    """
    log = _logger(out)
    stage_db = export_dir / STAGE_DB
    if not stage_db.exists():
        raise FileNotFoundError(f"{stage_db} doesn't exist; run stare-cl stage first")
    path = table_path(export_dir, "opinions", export)
    if not path.exists():
        raise FileNotFoundError(f"{path} doesn't exist")
    wanted = selected_clusters(stage_db)
    log(f"{len(wanted):,} selected clusters")

    text_db = export_dir / TEXT_DB
    if restart:
        text_db.unlink(missing_ok=True)
    db = sqlite3.connect(text_db)
    db.execute("PRAGMA synchronous = NORMAL")
    db.executescript(SCHEMA)
    progress = _progress(db)
    if progress.get("done") == "1":
        log(f"{text_db} is already complete; --restart to rebuild it")
        db.close()
        return {k: (int(v) if v.isdigit() else v) for k, v in progress.items()}
    skip = int(progress.get("records", "0"))
    kept = int(progress.get("kept", "0"))
    raw_bytes = int(progress.get("raw_bytes", "0"))
    if skip:
        log(f"resuming after record {skip:,}")

    def checkpoint(records: int, done: bool = False) -> None:
        db.executemany(
            "INSERT OR REPLACE INTO progress VALUES (?, ?)",
            [
                ("records", str(records)),
                ("kept", str(kept)),
                ("raw_bytes", str(raw_bytes)),
                ("done", "1" if done else "0"),
                ("source", path.name),
            ],
        )
        db.commit()

    record = 0
    pending: list[tuple] = []
    with open_table(path) as fh:
        for record, row in enumerate(read_table(fh, "opinions", OPINION_COLUMNS), start=1):
            if on_record is not None:
                on_record(record)
            if record <= skip:
                continue
            cluster_id = int(row["cluster_id"] or 0)
            if cluster_id in wanted:
                field, value = pick_text(row)
                data = value.encode("utf-8")
                raw_bytes += len(data)
                kept += 1
                pending.append(
                    (
                        int(row["id"] or 0),
                        cluster_id,
                        row["type"],
                        row["author_str"],
                        1 if row["per_curiam"] == "t" else 0,
                        row["joined_by_str"],
                        row["date_modified"],
                        field,
                        zlib.compress(data, 6),
                        len(data),
                    )
                )
            if record % CHECKPOINT == 0:
                db.executemany(
                    "INSERT OR REPLACE INTO opinions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    pending,
                )
                pending.clear()
                checkpoint(record)
                if record % (CHECKPOINT * 50) == 0:
                    log(f"  {record:,} opinions read, {kept:,} kept")
            if stop_after is not None and record >= stop_after:
                db.executemany(
                    "INSERT OR REPLACE INTO opinions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    pending,
                )
                checkpoint(record)
                db.close()
                return {"records": record, "kept": kept, "raw_bytes": raw_bytes, "done": 0}
    db.executemany("INSERT OR REPLACE INTO opinions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", pending)
    checkpoint(record, done=True)
    clusters = db.execute("SELECT count(DISTINCT cluster_id) FROM opinions").fetchone()[0]
    db.execute("INSERT OR REPLACE INTO progress VALUES ('clusters', ?)", (str(clusters),))
    db.commit()
    db.close()
    log(f"done: {record:,} opinions read, {kept:,} kept for {clusters:,} clusters")
    return {
        "records": record,
        "kept": kept,
        "clusters": clusters,
        "selected": len(wanted),
        "raw_bytes": raw_bytes,
    }
