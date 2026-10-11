"""The bucket listing of CourtListener's bulk export.

CourtListener publishes its database as dated CSV dumps in the public S3 bucket
``com-courtlistener-storage`` under ``bulk-data/``, one ``<table>-<YYYY-MM-DD>.csv.bz2``
object per table per export. The listing is plain ``ListObjectsV2`` over HTTPS with no
token, paged 1000 keys at a time. Not every dated file is real: every table dated
2024-03-01 (and several in 2022) is a 14-byte placeholder, and the tables of one export
can land hours apart, so an export counts as complete only when every table asked for is
listed at a plausible size.

Lifted from gorsuch-library's ``clbulk`` module (same author, same license).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

import httpx

BUCKET_URL = "https://com-courtlistener-storage.s3-us-west-2.amazonaws.com"
PREFIX = "bulk-data/"
DEFAULT_TABLES = ("opinion-clusters", "opinions", "dockets", "citations")
"""The tables stare mirrors by default."""
OPTIONAL_TABLES = ("citation-map", "courts", "people-db-people")
"""Further tables ``fetch`` accepts when asked for by name."""
KNOWN_TABLES = DEFAULT_TABLES + OPTIONAL_TABLES
MIN_TABLE_BYTES = 1_000_000
"""Smaller files are placeholders: every table dated 2024-03-01 is 14 bytes."""
SMALL_TABLES = {"courts": 10_000, "people-db-people": 100_000}
"""Tables whose real files are under ``MIN_TABLE_BYTES`` (courts was 81 KB and
people-db-people 456 KB on 2026-09-30), with the floor that still tells them from a
placeholder."""


def min_bytes_for(table: str, min_bytes: int = MIN_TABLE_BYTES) -> int:
    """The placeholder threshold for one table: ``min_bytes``, lowered for small tables."""
    return min(min_bytes, SMALL_TABLES.get(table, min_bytes))


_KEY = re.compile(
    rf"{re.escape(PREFIX)}(?P<table>[a-z0-9][a-z0-9-]*?)-(?P<date>\d{{4}}-\d{{2}}-\d{{2}})\.csv\.bz2"
)


@dataclass(frozen=True)
class Entry:
    """One dated table file in the bucket listing."""

    key: str
    table: str
    date: date
    size: int
    etag: str
    """As S3 lists it, quotes included (``"…"``, or ``"…-25"`` for a multipart upload)."""
    last_modified: str


def table_file(table: str, export: date) -> str:
    """The file name of one table of one export, e.g. ``opinions-2026-09-30.csv.bz2``."""
    return f"{table}-{export.isoformat()}.csv.bz2"


def table_key(table: str, export: date) -> str:
    """The bucket key of one table of one export."""
    return f"{PREFIX}{table_file(table, export)}"


def _local(tag: str) -> str:
    """An XML tag without its namespace."""
    return tag.rsplit("}", 1)[-1]


def parse_page(body: bytes) -> tuple[list[Entry], str | None]:
    """One page of a ``ListObjectsV2`` answer.

    Returns:
        The page's dated table files (other keys are skipped) and the continuation token
        when the listing is truncated, else None.
    """
    # The body comes from the bucket over HTTPS, and the stdlib parser expands no external
    # entities; a hostile listing could at worst make this slow.
    root = ET.fromstring(body)  # noqa: S314
    entries: list[Entry] = []
    token: str | None = None
    truncated = False
    for element in root:
        name = _local(element.tag)
        if name == "Contents":
            fields = {_local(child.tag): child.text or "" for child in element}
            match = _KEY.fullmatch(fields.get("Key", ""))
            if match is None:
                continue
            try:
                when = date.fromisoformat(match["date"])
            except ValueError:
                continue
            entries.append(
                Entry(
                    key=fields["Key"],
                    table=match["table"],
                    date=when,
                    size=int(fields["Size"]),
                    etag=fields.get("ETag", ""),
                    last_modified=fields.get("LastModified", ""),
                )
            )
        elif name == "IsTruncated":
            truncated = (element.text or "").strip() == "true"
        elif name == "NextContinuationToken":
            token = element.text
    return entries, token if truncated else None


def list_entries(
    http: httpx.Client, prefix: str = PREFIX, *, base_url: str = BUCKET_URL
) -> list[Entry]:
    """Every dated table file under a prefix, across every page of the listing.

    Args:
        http: The HTTP client.
        prefix: Key prefix, e.g. ``bulk-data/`` or ``bulk-data/opinions-``.
        base_url: Bucket URL.

    Raises:
        httpx.HTTPError: The bucket refused a request.
    """
    found: list[Entry] = []
    params = {"list-type": "2", "prefix": prefix}
    while True:
        response = http.get(f"{base_url}/", params=params)
        response.raise_for_status()
        page, token = parse_page(response.content)
        found.extend(page)
        if token is None:
            return found
        params = {"list-type": "2", "prefix": prefix, "continuation-token": token}


def complete_exports(
    entries: Iterable[Entry],
    tables: Iterable[str] = DEFAULT_TABLES,
    *,
    min_bytes: int = MIN_TABLE_BYTES,
) -> list[date]:
    """Export dates where every requested table is listed at ``min_bytes`` or more.

    Args:
        entries: The bucket listing.
        tables: The tables an export must have.
        min_bytes: A file smaller than this is a placeholder and doesn't count (lowered
            for the tables in ``SMALL_TABLES``).

    Returns:
        The dates, newest first.
    """
    wanted = set(tables)
    have: dict[date, set[str]] = {}
    for entry in entries:
        if entry.table in wanted and entry.size >= min_bytes_for(entry.table, min_bytes):
            have.setdefault(entry.date, set()).add(entry.table)
    return sorted((d for d, found in have.items() if found >= wanted), reverse=True)


def export_entries(
    entries: Iterable[Entry], export: date, tables: Iterable[str]
) -> dict[str, Entry]:
    """The listing's entry for each requested table of one export, in ``tables`` order.

    Raises:
        FileNotFoundError: A table of that date isn't listed.
    """
    by_key = {e.key: e for e in entries}
    found: dict[str, Entry] = {}
    for table in tables:
        key = table_key(table, export)
        if key not in by_key:
            raise FileNotFoundError(f"{key} is not in the bucket listing")
        found[table] = by_key[key]
    return found
