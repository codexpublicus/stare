"""Stage one export into SQLite and decide which clusters stare takes.

``stare-cl stage`` loads ``courts``, ``opinion-clusters`` and ``citations`` into
``<dest>/<date>/stage.sqlite``, classifies every cluster, then loads the ``dockets`` rows of
the clusters it selected. Each cluster gets one class:

``blocked``
    CourtListener marks the cluster blocked; stare never publishes it.
``no_citation``
    No reporter citation at all, so the resolver can't reach it.
``cap_held``
    A citation lands in a volume CAP's index holds (volume level), or, when a local copy of
    the index is given, on a page it resolves (page level).
``selected``
    Everything else: the cases stare takes from CourtListener.
``docket_blocked``
    Selected, but its docket is blocked; held back like ``blocked``.

SQLite rather than DuckDB: it is in the standard library, the work is a handful of indexed
joins over about 30 million rows, and the later steps want keyed lookups by cluster id
from several processes, which SQLite does well in read-only mode. The file is built under a
temporary name and renamed when complete, so a finished ``stage.sqlite`` is always whole.

The report (``stage-report.json``) has the class counts, how the page-level check moved
clusters, and a cross-check against the first sizing's reporter rule (CAP slug and
CourtListener reporter compared on lowercase letters and digits only).
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from datetime import date
from itertools import islice
from pathlib import Path
from typing import Any, TextIO

from stare_courtlistener.capindex import CapIndex, PageIndex, volume_key
from stare_courtlistener.listing import table_file
from stare_courtlistener.reporters import ReporterMap, alnum_slug, year_volume
from stare_courtlistener.table import open_table, read_table

STAGE_DB = "stage.sqlite"
STAGE_REPORT = "stage-report.json"
BATCH = 50_000

CLASSES = ("blocked", "no_citation", "cap_held", "selected", "docket_blocked")

COURT_COLUMNS = ("id", "full_name", "short_name", "citation_string", "jurisdiction")
CLUSTER_COLUMNS = (
    "id",
    "docket_id",
    "date_filed",
    "date_filed_is_approximate",
    "case_name_short",
    "case_name",
    "case_name_full",
    "slug",
    "precedential_status",
    "blocked",
    "filepath_json_harvard",
    "date_modified",
)
CITATION_COLUMNS = ("id", "cluster_id", "volume", "reporter", "page", "type")
DOCKET_COLUMNS = (
    "id",
    "court_id",
    "docket_number",
    "case_name_short",
    "case_name",
    "case_name_full",
    "blocked",
)

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE courts (
    id TEXT PRIMARY KEY, full_name TEXT, short_name TEXT, citation_string TEXT,
    jurisdiction TEXT
);
CREATE TABLE clusters (
    id INTEGER PRIMARY KEY, docket_id INTEGER, date_filed TEXT, date_approximate INTEGER,
    case_name_short TEXT, case_name TEXT, case_name_full TEXT, slug TEXT,
    precedential_status TEXT, blocked INTEGER, harvard INTEGER, date_modified TEXT,
    class TEXT, volume_held INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE citations (
    id INTEGER PRIMARY KEY, cluster_id INTEGER, volume TEXT, reporter TEXT, page TEXT,
    type INTEGER, volume_key TEXT, year_volume INTEGER
);
CREATE TABLE reporter_slugs (reporter TEXT, type INTEGER, year_volume INTEGER, slug TEXT);
CREATE TABLE reporter_alnum (reporter TEXT PRIMARY KEY, slug TEXT);
CREATE TABLE held_volumes (slug TEXT, volume TEXT, PRIMARY KEY (slug, volume)) WITHOUT ROWID;
CREATE TABLE dockets (
    id INTEGER PRIMARY KEY, court_id TEXT, docket_number TEXT, case_name_short TEXT,
    case_name TEXT, case_name_full TEXT, blocked INTEGER
);
"""

Log = Callable[[str], None]


def _logger(out: TextIO | None) -> Log:
    stream = out or sys.stderr
    start = time.monotonic()

    def log(message: str) -> None:
        print(f"[{time.monotonic() - start:7.0f}s] {message}", file=stream, flush=True)

    return log


def _int(value: str | None) -> int | None:
    return int(value) if value not in (None, "") else None


def _flag(value: str | None) -> int:
    return 1 if value == "t" else 0


def _batches(rows: Iterable[tuple[Any, ...]], size: int = BATCH) -> Iterator[list[tuple[Any, ...]]]:
    it = iter(rows)
    while batch := list(islice(it, size)):
        yield batch


def _load(
    db: sqlite3.Connection,
    sql: str,
    rows: Iterable[tuple[Any, ...]],
    log: Log,
    what: str,
    every: int = 1_000_000,
) -> int:
    count = 0
    for batch in _batches(rows):
        db.executemany(sql, batch)
        before, count = count, count + len(batch)
        if count // every != before // every:
            log(f"  {what}: {count:,}")
    db.commit()
    log(f"  {what}: {count:,} rows")
    return count


def table_path(export_dir: Path, table: str, export: date) -> Path:
    """The table's ``.csv.bz2`` in the export directory, or a plain ``.csv`` beside it."""
    path = export_dir / table_file(table, export)
    plain = path.with_suffix("")
    if not path.exists() and plain.exists():
        return plain
    return path


def _rows(export_dir: Path, table: str, export: date, columns: Iterable[str]) -> Iterator[dict]:
    path = table_path(export_dir, table, export)
    if not path.exists():
        raise FileNotFoundError(f"{path} doesn't exist")
    with open_table(path) as fh:
        yield from read_table(fh, table, list(columns))


def connect(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    else:
        db = sqlite3.connect(path)
        db.execute("PRAGMA journal_mode = OFF")
        db.execute("PRAGMA synchronous = OFF")
    db.execute("PRAGMA cache_size = -512000")
    db.execute("PRAGMA temp_store = MEMORY")
    return db


def classify(
    db: sqlite3.Connection,
    index: CapIndex,
    reporters: ReporterMap,
    page_index: PageIndex | None,
    log: Log,
) -> None:
    """Fill ``clusters.class`` (and ``volume_held``) from the loaded clusters and citations."""
    db.executemany(
        "INSERT INTO held_volumes VALUES (?, ?)",
        ((slug, vol) for slug, vols in index.folders.items() for vol in vols),
    )
    pairs = db.execute("SELECT DISTINCT reporter, type, year_volume FROM citations").fetchall()
    # the volume only matters as a year (2021 ND 1) or not (310 Neb. 1); see reporters.py
    db.executemany(
        "INSERT INTO reporter_slugs VALUES (?, ?, ?, ?)",
        (
            (r, t, y, slug)
            for r, t, y in pairs
            for slug in reporters.slugs(r, t, "2000" if y else "1")
        ),
    )
    held_slugs = list(index.folders)
    db.executemany(
        "INSERT OR IGNORE INTO reporter_alnum VALUES (?, ?)",
        ((r, s) for r, _, _ in pairs if (s := alnum_slug(r, held_slugs)) is not None),
    )
    db.commit()
    log(f"  {len(pairs):,} reporter spellings, {len(index.folders)} CAP reporters")

    db.executescript(
        """
        CREATE TEMP TABLE cites_in_held AS
            SELECT c.cluster_id, s.slug, c.volume_key, c.page
            FROM citations c
            JOIN reporter_slugs s
              ON s.reporter = c.reporter AND s.type IS c.type AND s.year_volume = c.year_volume
            JOIN held_volumes h ON h.slug = s.slug AND h.volume = c.volume_key;
        CREATE TEMP TABLE volume_held (cluster_id INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO volume_held SELECT cluster_id FROM cites_in_held;
        CREATE TEMP TABLE alnum_held (cluster_id INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO alnum_held
            SELECT c.cluster_id FROM citations c
            JOIN reporter_alnum a ON a.reporter = c.reporter
            JOIN held_volumes h ON h.slug = a.slug AND h.volume = c.volume_key;
        CREATE TEMP TABLE cited (cluster_id INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO cited SELECT cluster_id FROM citations;
        """
    )
    log("  joined citations to CAP's volumes")

    db.execute("CREATE TEMP TABLE held (cluster_id INTEGER PRIMARY KEY)")
    if page_index is None:
        db.execute("INSERT INTO held SELECT cluster_id FROM temp.volume_held")
    else:
        found: list[tuple[int]] = []
        rows = db.execute(
            "SELECT cluster_id, slug, volume_key, page FROM cites_in_held ORDER BY slug, volume_key"
        )
        for cluster_id, slug, volume, page in rows:
            if page_index.holds_page(slug, volume, page):
                found.append((cluster_id,))
        db.executemany("INSERT OR IGNORE INTO held VALUES (?)", found)
        log(f"  checked pages: {len(found):,} citations on a CAP page")

    db.executescript(
        """
        UPDATE clusters SET class = CASE
            WHEN blocked THEN 'blocked'
            WHEN id NOT IN (SELECT cluster_id FROM temp.cited) THEN 'no_citation'
            WHEN id IN (SELECT cluster_id FROM temp.held) THEN 'cap_held'
            ELSE 'selected' END;
        UPDATE clusters SET volume_held = 1
            WHERE class = 'selected' AND id IN (SELECT cluster_id FROM temp.volume_held);
        CREATE INDEX clusters_class ON clusters (class);
        """
    )
    db.commit()
    log("  classified")


def _crosscheck(db: sqlite3.Connection) -> dict[str, Any]:
    """Where this classification and the first sizing's alnum rule disagree (volume level)."""
    only_new = db.execute(
        """SELECT count(*) FROM temp.volume_held v JOIN clusters k ON k.id = v.cluster_id
           WHERE NOT k.blocked AND v.cluster_id NOT IN (SELECT cluster_id FROM temp.alnum_held)"""
    ).fetchone()[0]
    only_alnum = db.execute(
        """SELECT count(*) FROM temp.alnum_held a JOIN clusters k ON k.id = a.cluster_id
           WHERE NOT k.blocked AND a.cluster_id NOT IN (SELECT cluster_id FROM temp.volume_held)"""
    ).fetchone()[0]

    def reporters_of(sql: str) -> list[list[Any]]:
        return [list(r) for r in db.execute(sql).fetchall()]

    held_new_only = reporters_of(
        """SELECT c.reporter, count(DISTINCT c.cluster_id) n FROM citations c
           JOIN reporter_slugs s
              ON s.reporter = c.reporter AND s.type IS c.type AND s.year_volume = c.year_volume
           JOIN held_volumes h ON h.slug = s.slug AND h.volume = c.volume_key
           JOIN clusters k ON k.id = c.cluster_id AND NOT k.blocked
           WHERE c.cluster_id NOT IN (SELECT cluster_id FROM temp.alnum_held)
           GROUP BY c.reporter ORDER BY n DESC LIMIT 20"""
    )
    held_alnum_only = reporters_of(
        """SELECT c.reporter, count(DISTINCT c.cluster_id) n FROM citations c
           JOIN reporter_alnum a ON a.reporter = c.reporter
           JOIN held_volumes h ON h.slug = a.slug AND h.volume = c.volume_key
           JOIN clusters k ON k.id = c.cluster_id AND NOT k.blocked
           WHERE c.cluster_id NOT IN (SELECT cluster_id FROM temp.volume_held)
           GROUP BY c.reporter ORDER BY n DESC LIMIT 20"""
    )
    return {
        "held_only_by_this_mapping": only_new,
        "held_only_by_alnum_rule": only_alnum,
        "reporters_held_only_by_this_mapping": held_new_only,
        "reporters_held_only_by_alnum_rule": held_alnum_only,
    }


def report(db: sqlite3.Connection, export: date, index: CapIndex, page_level: bool) -> dict:
    counts = dict.fromkeys(CLASSES, 0)
    counts.update(dict(db.execute("SELECT class, count(*) FROM clusters GROUP BY class")))
    one = lambda sql: db.execute(sql).fetchone()[0]  # noqa: E731
    top = db.execute(
        """SELECT c.reporter, count(DISTINCT c.cluster_id) n FROM citations c
            JOIN clusters k ON k.id = c.cluster_id WHERE k.class = 'selected'
            GROUP BY c.reporter ORDER BY n DESC LIMIT 40"""
    ).fetchall()
    return {
        "export": export.isoformat(),
        "index_version": index.version,
        "level": "page" if page_level else "volume",
        "clusters": one("SELECT count(*) FROM clusters"),
        "citations": one("SELECT count(*) FROM citations"),
        "classes": counts,
        "selected": {
            "decided_2019_or_later": one(
                "SELECT count(*) FROM clusters WHERE class = 'selected' AND date_filed >= '2019'"
            ),
            "harvard": one("SELECT count(*) FROM clusters WHERE class = 'selected' AND harvard"),
            "in_a_cap_volume_but_not_on_a_cap_page": one(
                "SELECT count(*) FROM clusters WHERE class = 'selected' AND volume_held"
            ),
            "without_docket": one(
                """SELECT count(*) FROM clusters WHERE class = 'selected'
                    AND docket_id NOT IN (SELECT id FROM dockets)"""
            ),
            "top_reporters": [list(r) for r in top],
        },
        "crosscheck_alnum_rule": _crosscheck(db),
    }


def stage_export(
    export_dir: Path,
    export: date,
    index: CapIndex,
    *,
    page_index: PageIndex | None = None,
    reporters: ReporterMap | None = None,
    out: TextIO | None = None,
) -> dict[str, Any]:
    """Build ``stage.sqlite`` and ``stage-report.json`` in ``export_dir``; return the report."""
    log = _logger(out)
    reporters = reporters or ReporterMap()
    final = export_dir / STAGE_DB
    tmp = export_dir / (STAGE_DB + ".tmp")
    tmp.unlink(missing_ok=True)
    db = connect(tmp)
    db.executescript(SCHEMA)

    log("courts")
    _load(
        db,
        "INSERT INTO courts VALUES (?, ?, ?, ?, ?)",
        (
            tuple(r[c] for c in COURT_COLUMNS)
            for r in _rows(export_dir, "courts", export, COURT_COLUMNS)
        ),
        log,
        "courts",
    )

    log("opinion-clusters")
    _load(
        db,
        "INSERT INTO clusters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)",
        (
            (
                int(r["id"]),
                _int(r["docket_id"]),
                r["date_filed"],
                _flag(r["date_filed_is_approximate"]),
                r["case_name_short"],
                r["case_name"],
                r["case_name_full"],
                r["slug"],
                r["precedential_status"],
                _flag(r["blocked"]),
                1 if r["filepath_json_harvard"] else 0,
                r["date_modified"],
            )
            for r in _rows(export_dir, "opinion-clusters", export, CLUSTER_COLUMNS)
        ),
        log,
        "clusters",
    )

    log("citations")
    _load(
        db,
        "INSERT INTO citations VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            (
                int(r["id"]),
                int(r["cluster_id"]),
                r["volume"],
                r["reporter"],
                r["page"],
                _int(r["type"]),
                volume_key(r["volume"] or ""),
                1 if year_volume(r["volume"]) else 0,
            )
            for r in _rows(export_dir, "citations", export, CITATION_COLUMNS)
        ),
        log,
        "citations",
    )
    db.execute("CREATE INDEX citations_cluster ON citations (cluster_id)")
    db.commit()

    log("classifying")
    classify(db, index, reporters, page_index, log)

    log("dockets (of selected clusters only)")
    wanted = {
        d for (d,) in db.execute("SELECT docket_id FROM clusters WHERE class = 'selected'") if d
    }
    _load(
        db,
        "INSERT INTO dockets VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            (
                int(r["id"]),
                r["court_id"],
                r["docket_number"],
                r["case_name_short"],
                r["case_name"],
                r["case_name_full"],
                _flag(r["blocked"]),
            )
            for r in _rows(export_dir, "dockets", export, DOCKET_COLUMNS)
            if int(r["id"]) in wanted
        ),
        log,
        "dockets",
    )
    db.execute(
        """UPDATE clusters SET class = 'docket_blocked' WHERE class = 'selected'
           AND docket_id IN (SELECT id FROM dockets WHERE blocked)"""
    )
    db.commit()

    result = report(db, export, index, page_index is not None)
    if page_index is not None:
        result["index_volumes_missing"] = len(page_index.missing)
    db.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("export", export.isoformat()),
            ("index_version", index.version),
            ("level", result["level"]),
        ],
    )
    db.commit()
    db.close()
    tmp.replace(final)
    (export_dir / STAGE_REPORT).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {final} and {STAGE_REPORT}")
    return result
