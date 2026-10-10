"""Resumable download of one bulk export, and the ``export.json`` that records it.

Each table downloads to ``<dest>/<date>/<table>-<date>.csv.bz2`` by way of a ``.part``
file, renamed only once its size matches the bucket listing, so a finished name is always
a whole file. The ETag the ``.part`` came from is kept beside it in ``.part.etag``. A rerun
skips finished files and continues a ``.part`` from its last byte with a ``Range`` request
and ``If-Range: <etag>``, so if the object has been replaced since, S3 sends the whole new
object (200) and the download starts over instead of splicing two versions together. A
206 whose ETag differs from the sidecar's (a server that honors Range but not If-Range)
drops the ``.part``, and so does a ``.part`` with no sidecar or one the listing no longer
shows. A whole-object answer whose ETag isn't the listed one stops the fetch with
``ObjectChangedError``: the object was replaced after the listing was read, and a rerun
lists it again. A dropped connection or a 5xx is retried with exponential backoff capped
at 60 s.

``export.json`` records, per table, the bucket key, size, ETag, LastModified and the
SHA-256 of the downloaded file (S3's ETags for these multipart uploads are not content
hashes), plus the bulk-data page's terms statement as it read when last checked.

The download loop is lifted from gorsuch-library's ``clbulk`` module (same author, same
license).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx

from stare_courtlistener import __version__
from stare_courtlistener.listing import (
    BUCKET_URL,
    DEFAULT_TABLES,
    MIN_TABLE_BYTES,
    PREFIX,
    Entry,
    export_entries,
    list_entries,
    min_bytes_for,
    table_file,
)

MANIFEST = "export.json"
MANIFEST_FORMAT = "stare-courtlistener.export"
MANIFEST_VERSION = 1
TERMS = {
    "statement": "Our bulk data files are free of known copyright restrictions.",
    "url": "https://www.courtlistener.com/help/api/bulk-data/",
    "mark": "https://creativecommons.org/publicdomain/mark/1.0/",
    "checked": "2026-10-10",
}
"""The bulk-data page's statement, verbatim, with the mark it links and the date it was read."""
MAX_BACKOFF_S = 60.0
_CHUNK = 1 << 20

Progress = Callable[[str, int, int], None]
"""Called with ``(file name, bytes so far, bytes in all)``."""


class ObjectChangedError(ValueError):
    """The bucket sent a different version of an object than its listing named."""


def sha256_file(path: Path) -> str:
    """The hex SHA-256 of a file, read in 1 MiB chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def export_dir(dest: Path, export: date) -> Path:
    """Where one export's files go: ``<dest>/<date>``."""
    return dest / export.isoformat()


def read_manifest(directory: Path) -> dict[str, Any] | None:
    """An export directory's ``export.json``, or None when there isn't one."""
    path = directory / MANIFEST
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_manifest(directory: Path, manifest: dict[str, Any]) -> None:
    path = directory / MANIFEST
    tmp = directory / f"{MANIFEST}.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def fetch_export(
    export: date,
    dest: Path,
    http: httpx.Client,
    *,
    tables: Iterable[str] = DEFAULT_TABLES,
    entries: Iterable[Entry] | None = None,
    base_url: str = BUCKET_URL,
    min_bytes: int = MIN_TABLE_BYTES,
    attempts: int = 8,
    sleep: Callable[[float], None] = time.sleep,
    on_progress: Progress | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Path:
    """Download the requested tables of one export, resuming any partial file.

    Tables already recorded in the directory's ``export.json`` from an earlier run, and
    not requested this time, stay recorded.

    Args:
        export: The export date.
        dest: The mirror root; the files go to ``dest/<date>/``.
        http: The HTTP client.
        tables: The tables to fetch.
        entries: The bucket listing, when the caller already has it.
        base_url: Bucket URL.
        min_bytes: A listed file smaller than this is a placeholder, and refused (lowered
            for the tables in ``SMALL_TABLES``).
        attempts: Tries per table before giving up on a dropped connection, a 5xx or a
            body that ends short.
        sleep: Sleep callable, for the pause between tries.
        on_progress: Progress callback.
        now: Clock, for ``fetched_at``.

    Returns:
        The export directory.

    Raises:
        FileNotFoundError: A table isn't in the bucket listing.
        ValueError: A table is a placeholder, a finished file disagrees with the listing,
            or a download still ends at the wrong size after every try.
        httpx.HTTPError: The bucket refused a request, or every try failed.
    """
    tables = list(tables)
    if entries is None:
        entries = list_entries(http, base_url=base_url)
    wanted = export_entries(entries, export, tables)
    for entry in wanted.values():
        if entry.size < min_bytes_for(entry.table, min_bytes):
            raise ValueError(f"{entry.key} is a {entry.size}-byte placeholder, not an export")
    directory = export_dir(dest, export)
    directory.mkdir(parents=True, exist_ok=True)
    manifest = read_manifest(directory) or {}
    recorded: dict[str, Any] = dict(manifest.get("tables", {}))
    for table, entry in wanted.items():
        final = directory / table_file(table, export)
        before = recorded.get(table)
        if (
            final.exists()
            and before is not None
            and (before.get("etag"), before.get("size")) != (entry.etag, entry.size)
        ):
            raise ValueError(
                f"{final} was fetched as ETag {before.get('etag')}, {before.get('size')} bytes, "
                f"but the bucket now lists {entry.etag}, {entry.size} bytes; the export was "
                f"replaced. Move the directory aside and fetch again"
            )
        fresh = download(
            entry,
            final,
            http,
            base_url=base_url,
            attempts=attempts,
            sleep=sleep,
            on_progress=on_progress,
        )
        if fresh or before is None or before.get("sha256") is None:
            digest = sha256_file(final)
            fetched_at = now().isoformat(timespec="seconds")
        else:
            digest, fetched_at = before["sha256"], before.get("fetched_at")
        recorded[table] = {
            "key": entry.key,
            "file": final.name,
            "size": entry.size,
            "etag": entry.etag,
            "last_modified": entry.last_modified,
            "sha256": digest,
            "fetched_at": fetched_at,
        }
        _write_manifest(
            directory,
            {
                "format": MANIFEST_FORMAT,
                "format_version": MANIFEST_VERSION,
                "date": export.isoformat(),
                "source": f"{base_url}/{PREFIX}",
                "fetcher": f"stare-courtlistener {__version__}",
                "terms": TERMS,
                "tables": recorded,
            },
        )
    return directory


def download(
    entry: Entry,
    final: Path,
    http: httpx.Client,
    *,
    base_url: str = BUCKET_URL,
    attempts: int = 8,
    sleep: Callable[[float], None] = time.sleep,
    on_progress: Progress | None = None,
) -> bool:
    """Download one listed object to ``final``, resuming its ``.part``.

    Returns:
        True when bytes were downloaded, False when ``final`` was already whole.

    Raises:
        ObjectChangedError: The bucket sent another version than ``entry`` lists.
        ValueError: ``final`` exists at the wrong size, or the download still ends at the
            wrong size after every try.
        httpx.HTTPError: A 4xx, or every try failed.
    """
    size, etag = entry.size, entry.etag
    if final.exists():
        if final.stat().st_size != size:
            raise ValueError(
                f"{final} is {final.stat().st_size} bytes but the bucket lists {size}; "
                f"delete it and fetch again"
            )
        return False
    part = final.with_name(f"{final.name}.part")
    sidecar = final.with_name(f"{final.name}.part.etag")
    held = sidecar.read_text(encoding="utf-8").strip() if sidecar.exists() else ""
    if part.exists() and (not held or held != etag or part.stat().st_size > size):
        part.unlink()  # not provably a prefix of the listed object: start over
    url = f"{base_url}/{entry.key}"

    def report(n: int) -> None:
        if on_progress is not None:
            on_progress(final.name, n, size)

    for attempt in range(1, attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        if have == size:
            break
        if have > size:
            part.unlink()
        try:
            _get(http, url, part, sidecar, etag, report)
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500:
                raise
            if attempt == attempts:
                raise
            sleep(backoff(attempt))
            continue
        got = part.stat().st_size if part.exists() else 0
        if got < size and attempt < attempts:
            sleep(backoff(attempt))
    got = part.stat().st_size if part.exists() else 0
    if got != size:
        raise ValueError(
            f"{part} ended at {got} bytes after {attempts} tries; the bucket lists {size}"
        )
    os.replace(part, final)
    sidecar.unlink(missing_ok=True)
    return True


def backoff(attempt: int) -> float:
    """Seconds to wait after failed try ``attempt`` (1-based): 2, 4, 8, … capped at 60."""
    return min(MAX_BACKOFF_S, 2.0**attempt)


def _get(
    http: httpx.Client,
    url: str,
    part: Path,
    sidecar: Path,
    etag: str,
    progress: Callable[[int], None],
) -> None:
    """Append the rest of one object to ``part``, from its current end.

    A resume sends ``If-Range`` with the ETag in ``sidecar``; a 200 answer means the
    object changed (or the range was ignored), and ``part`` is rewritten from the first
    byte. A 206 whose ETag differs from the sidecar's deletes ``part`` and its sidecar, so
    the next try starts over. Each fresh response's ETag is written to ``sidecar`` before
    any of its bytes reach ``part``.
    """
    have = part.stat().st_size if part.exists() else 0
    headers: dict[str, str] = {}
    if have:
        held = sidecar.read_text(encoding="utf-8").strip()
        headers = {"Range": f"bytes={have}-", "If-Range": held}
    with http.stream("GET", url, headers=headers, timeout=httpx.Timeout(60.0)) as response:
        if response.status_code == 206 and have:
            content_range = response.headers.get("content-range", "")
            try:
                start = int(content_range.split()[1].split("-")[0])
            except (IndexError, ValueError):
                raise ValueError(f"{url}: unreadable Content-Range {content_range!r}") from None
            if start != have:
                raise ValueError(f"{url}: asked for byte {have}, got a range from {start}")
            sent = response.headers.get("etag")
            if sent is not None and sent != headers["If-Range"]:
                # Range honored but If-Range ignored: this is a range of another version.
                part.unlink(missing_ok=True)
                sidecar.unlink(missing_ok=True)
                return
            mode = "ab"
        elif response.status_code in (200, 206):
            mode, have = "wb", 0  # a new object, or the range was ignored: start over
            sent = response.headers.get("etag", etag)
            if sent != etag:
                part.unlink(missing_ok=True)
                sidecar.unlink(missing_ok=True)
                raise ObjectChangedError(
                    f"{url} is ETag {sent} but the listing said {etag}: the object was "
                    f"replaced after the listing was read. Fetch again"
                )
            sidecar.write_text(sent + "\n", encoding="utf-8")
        else:
            response.raise_for_status()
            raise ValueError(f"{url}: unexpected HTTP {response.status_code}")
        with part.open(mode) as out:
            for chunk in response.iter_bytes(_CHUNK):
                out.write(chunk)
                have += len(chunk)
                progress(have)


def verify_export(directory: Path) -> tuple[list[str], list[str]]:
    """Re-hash an export directory's files against its ``export.json``.

    Returns:
        ``(passed, failures)``: the tables whose file matches its recorded size and
        SHA-256, and one message per table that doesn't.

    Raises:
        FileNotFoundError: The directory has no ``export.json``.
    """
    manifest = read_manifest(directory)
    if manifest is None:
        raise FileNotFoundError(f"{directory / MANIFEST} doesn't exist")
    passed: list[str] = []
    failures: list[str] = []
    for table, record in manifest.get("tables", {}).items():
        path = directory / record["file"]
        if not path.exists():
            failures.append(f"{table}: {path.name} is missing")
            continue
        size = path.stat().st_size
        if size != record["size"]:
            failures.append(f"{table}: {path.name} is {size} bytes, recorded {record['size']}")
            continue
        digest = sha256_file(path)
        if digest != record["sha256"]:
            failures.append(
                f"{table}: {path.name} has SHA-256 {digest}, recorded {record['sha256']}"
            )
            continue
        passed.append(table)
    return passed, failures
