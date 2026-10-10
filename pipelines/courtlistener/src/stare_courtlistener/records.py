"""Build every selected cluster's record, the export manifest, and the delta.

``stare-cl records`` reads ``stage.sqlite`` and ``text.sqlite`` and writes, under ``--out``
(the bucket's layout, ``<dest>/out`` by default):

``cl/c/<cluster_id>/<hash>.json.gz``
    One record (``record.py``). Immutable: an existing file is left alone.
``cl/exports/<date>/manifest.ndjson.gz``
    One line per record, by cluster id: ``id``, ``hash``, ``first_seen``, and the
    citations with the CAP slugs each may be in (what slice 4's ``.cl`` sidecars need).
``cl/exports/<date>/delta.json``
    ``added``, ``changed`` and ``removed`` cluster ids against ``--previous`` (a previous
    export's directory or its ``manifest.ndjson.gz``); without one, every id is added.
``cl/exports/<date>/export.json``
    A copy of the fetch step's ``export.json``.

``first_seen`` comes from the previous manifest when the cluster was in it, else it is this
export's date. A selected cluster with no opinion text (none spooled, or every opinion
empty) gets no record and is counted in ``records-report.json``.

Records are built in worker processes (``--jobs``), each reading the SQLite files
read-only; the parent writes the manifest in cluster-id order.
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import statistics
import zlib
from collections import Counter
from collections.abc import Iterator
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path
from typing import Any, TextIO

from stare_courtlistener.record import (
    OPINION_TYPES,
    Cite,
    Opinion,
    build_record,
    record_bytes,
    record_hash,
)
from stare_courtlistener.reporters import ReporterMap
from stare_courtlistener.spool import TEXT_DB
from stare_courtlistener.stage import STAGE_DB, _logger, connect

RECORDS_REPORT = "records-report.json"
MANIFEST = "manifest.ndjson.gz"
DELTA = "delta.json"
CHUNK = 500

PrevEntry = dict[str, Any]


def export_out(out: Path, export: date) -> Path:
    return out / "cl" / "exports" / export.isoformat()


def record_path(out: Path, cluster_id: int, digest: str) -> Path:
    return out / "cl" / "c" / str(cluster_id) / f"{digest}.json.gz"


def read_manifest(path: Path) -> dict[int, PrevEntry]:
    """A manifest's entries by cluster id; ``path`` is the file or its export directory."""
    if path.is_dir():
        path = path / MANIFEST
    entries: dict[int, PrevEntry] = {}
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                entry = json.loads(line)
                entries[int(entry["id"])] = entry
    return entries


def compute_delta(
    current: dict[int, str], previous: dict[int, PrevEntry] | None
) -> dict[str, list[int]]:
    """``added``, ``changed`` and ``removed`` ids, each sorted; no previous → all added."""
    if previous is None:
        return {"added": sorted(current), "changed": [], "removed": []}
    return {
        "added": sorted(i for i in current if i not in previous),
        "changed": sorted(
            i for i, h in current.items() if i in previous and previous[i]["hash"] != h
        ),
        "removed": sorted(i for i in previous if i not in current),
    }


def first_seen_of(cluster_id: int, export: str, seen: dict[int, str] | None) -> str:
    """The previous manifest's ``first_seen`` for the cluster, else this export's date."""
    if seen is not None and seen.get(cluster_id):
        return seen[cluster_id]
    return export


# --- worker side -------------------------------------------------------------------------

_WORKER: dict[str, Any] = {}


def _init_worker(export_dir: str, out: str, export: str, seen: dict[int, str] | None) -> None:
    stage = connect(Path(export_dir) / STAGE_DB, readonly=True)
    stage.row_factory = _dict_row
    text = connect(Path(export_dir) / TEXT_DB, readonly=True)
    _WORKER.update(
        stage=stage,
        text=text,
        out=Path(out),
        export=export,
        seen=seen,
        reporters=ReporterMap(),
    )


def _dict_row(cursor: Any, row: tuple) -> dict[str, Any]:
    return {d[0]: v for d, v in zip(cursor.description, row, strict=True)}


def _build_chunk(cluster_ids: list[int]) -> list[dict[str, Any]]:
    stage, text, out = _WORKER["stage"], _WORKER["text"], _WORKER["out"]
    export, seen, reporters = _WORKER["export"], _WORKER["seen"], _WORKER["reporters"]
    results = []
    for cluster_id in cluster_ids:
        cluster = stage.execute("SELECT * FROM clusters WHERE id = ?", (cluster_id,)).fetchone()
        docket = stage.execute(
            "SELECT * FROM dockets WHERE id = ?", (cluster["docket_id"],)
        ).fetchone()
        court = None
        if docket and docket["court_id"]:
            court = stage.execute(
                "SELECT * FROM courts WHERE id = ?", (docket["court_id"],)
            ).fetchone()
        cites = [
            Cite(r["volume"] or "", r["reporter"] or "", r["page"] or "", r["type"])
            for r in stage.execute(
                "SELECT * FROM citations WHERE cluster_id = ? ORDER BY id", (cluster_id,)
            )
        ]
        opinions = [
            Opinion(
                oid,
                kind,
                author,
                field,
                zlib.decompress(raw).decode("utf-8") if raw else "",
            )
            for oid, kind, author, field, raw in text.execute(
                "SELECT id, type, author_str, text_field, raw FROM opinions WHERE cluster_id = ?",
                (cluster_id,),
            )
        ]
        result: dict[str, Any] = {
            "id": cluster_id,
            "opinions": len(opinions),
            "types": [o.type for o in opinions],
            "docket": docket is not None,
            "court": court is not None,
        }
        record = build_record(
            cluster,
            docket,
            court,
            cites,
            opinions,
            export=export,
            first_seen=first_seen_of(cluster_id, export, seen),
        )
        if not record["casebody"]["opinions"]:
            result["empty"] = True
            results.append(result)
            continue
        digest = record_hash(record)
        path = record_path(out, cluster_id, digest)
        data = record_bytes(record)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        result.update(
            hash=digest,
            gz_bytes=len(data),
            first_seen=record["source"]["first_seen"],
            jurisdiction=record["jurisdiction"]["name_long"],
            text_field=record["source"]["text_field"],
            citations=[
                {
                    "cite": c.text(),
                    "volume": c.volume,
                    "reporter": c.reporter,
                    "page": c.page,
                    "type": c.type,
                    "cap_slugs": list(reporters.slugs(c.reporter, c.type, c.volume)),
                }
                for c in cites
            ],
        )
        results.append(result)
    return results


# --- parent side -------------------------------------------------------------------------


def _chunks(ids: list[int], size: int) -> Iterator[list[int]]:
    for start in range(0, len(ids), size):
        yield ids[start : start + size]


def _results(ids: list[int], init: tuple, workers: int, log: Any) -> Iterator[dict[str, Any]]:
    """Each cluster's build result, in ``ids`` order."""
    done = 0
    if workers == 1:
        _init_worker(*init)
        for chunk in _chunks(ids, CHUNK):
            yield from _build_chunk(chunk)
        return
    with ProcessPoolExecutor(workers, initializer=_init_worker, initargs=init) as pool:
        for batch in pool.map(_build_chunk, _chunks(ids, CHUNK)):
            yield from batch
            done += len(batch)
            if done % (CHUNK * 100) == 0:
                log(f"  {done:,} / {len(ids):,}")


def _percentile(values: list[int], q: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


def build_records(
    export_dir: Path,
    export: date,
    out: Path,
    *,
    previous: Path | None = None,
    jobs: int | None = None,
    log_to: TextIO | None = None,
) -> dict[str, Any]:
    """Write the records, manifest, delta and export.json; return the report."""
    log = _logger(log_to)
    for name in (STAGE_DB, TEXT_DB):
        if not (export_dir / name).exists():
            raise FileNotFoundError(f"{export_dir / name} doesn't exist")
    text = connect(export_dir / TEXT_DB, readonly=True)
    progress = dict(text.execute("SELECT key, value FROM progress"))
    spooled = {cid for (cid,) in text.execute("SELECT DISTINCT cluster_id FROM opinions")}
    text.close()
    stage = connect(export_dir / STAGE_DB, readonly=True)
    selected = sorted(
        cid for (cid,) in stage.execute("SELECT id FROM clusters WHERE class = 'selected'")
    )
    stage.close()
    ids = [cid for cid in selected if cid in spooled]
    log(f"{len(selected):,} selected clusters, {len(ids):,} with spooled opinions")

    prev = read_manifest(previous) if previous is not None else None
    seen = {i: e.get("first_seen") or "" for i, e in prev.items()} if prev is not None else None
    export_s = export.isoformat()
    workers = jobs or os.cpu_count() or 1
    target = export_out(out, export)
    target.mkdir(parents=True, exist_ok=True)

    current: dict[int, str] = {}
    sizes: list[int] = []
    types: Counter[str] = Counter()
    fields: Counter[str] = Counter()
    counts: Counter[str] = Counter()
    init = (str(export_dir), str(out), export_s, seen)
    tmp = target / (MANIFEST + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=9) as fh:
        for r in _results(ids, init, workers, log):
            types.update(t or "" for t in r["types"])
            counts["without_docket"] += not r["docket"]
            counts["without_court"] += not r["court"]
            if r.get("empty"):
                counts["no_text"] += 1
                continue
            counts["without_jurisdiction"] += not r["jurisdiction"]
            field = r["text_field"]
            fields[field if isinstance(field, str) else "mixed"] += 1
            sizes.append(r["gz_bytes"])
            current[r["id"]] = r["hash"]
            line = {
                "id": r["id"],
                "hash": r["hash"],
                "first_seen": r["first_seen"],
                "citations": r["citations"],
            }
            fh.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")
    tmp.replace(target / MANIFEST)

    delta = compute_delta(current, prev)
    delta_doc = {
        "export": export_s,
        "previous": _previous_export(previous),
        "counts": {k: len(v) for k, v in delta.items()} | {"live": len(current)},
        **delta,
    }
    (target / DELTA).write_text(json.dumps(delta_doc) + "\n", encoding="utf-8")
    fetched = export_dir / "export.json"
    if fetched.exists():
        shutil.copyfile(fetched, target / "export.json")

    report = {
        "export": export_s,
        "text_complete": progress.get("done") == "1",
        "selected": len(selected),
        "with_opinions": len(ids),
        "records": len(current),
        "no_text": counts["no_text"],
        "without_docket": counts["without_docket"],
        "without_court": counts["without_court"],
        "without_jurisdiction": counts["without_jurisdiction"],
        "gz_bytes": {
            "total": sum(sizes),
            "median": int(statistics.median(sizes)) if sizes else 0,
            "p95": _percentile(sizes, 0.95),
            "max": max(sizes, default=0),
        },
        "opinion_types": dict(types.most_common()),
        "unmapped_opinion_types": sorted(t for t in types if t not in OPINION_TYPES),
        "text_fields": dict(fields.most_common()),
        "delta": delta_doc["counts"],
    }
    (export_dir / RECORDS_REPORT).write_text(json.dumps(report, indent=2) + "\n", "utf-8")
    log(f"wrote {len(current):,} records; manifest and delta in {target}")
    return report


def _previous_export(previous: Path | None) -> str | None:
    if previous is None:
        return None
    directory = previous if previous.is_dir() else previous.parent
    return directory.name
