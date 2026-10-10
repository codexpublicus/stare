from datetime import date

import pytest
from fakes3 import LAST_MODIFIED, Bucket, etag, objects

from stare_courtlistener.listing import (
    DEFAULT_TABLES,
    Entry,
    complete_exports,
    export_entries,
    list_entries,
    min_bytes_for,
    parse_page,
    table_key,
)


def _entry(table: str, when: str, size: int = 2_000_000) -> Entry:
    d = date.fromisoformat(when)
    return Entry(table_key(table, d), table, d, size, '"x"', LAST_MODIFIED)


def _export(when: str, size: int = 2_000_000, tables=DEFAULT_TABLES) -> list[Entry]:
    return [_entry(t, when, size) for t in tables]


def test_list_entries_follows_continuation_tokens_and_parses_every_field() -> None:
    contents = {**objects("2026-06-30"), **objects("2026-09-30")}
    bucket = Bucket(contents, page_size=3)
    entries = list_entries(bucket.client())
    assert len(bucket.requests) == 3
    assert {e.key for e in entries} == set(contents)
    key = table_key("people-db-people", date(2026, 9, 30))
    bucket = Bucket({key: b"abc"})
    (entry,) = list_entries(bucket.client())
    assert entry == Entry(
        key, "people-db-people", date(2026, 9, 30), 3, etag(b"abc"), LAST_MODIFIED
    )


def test_list_entries_skips_keys_that_arent_dated_tables() -> None:
    bucket = Bucket(objects())
    bucket.extra_keys = [
        "bulk-data/",
        "bulk-data/schema-2026-09-30.sql",
        "bulk-data/opinions-latest.csv.bz2",
        "bulk-data/opinions-2026-13-45.csv.bz2",
    ]
    assert {e.table for e in list_entries(bucket.client())} == set(DEFAULT_TABLES)


def test_parse_page_keeps_s3s_quoted_multipart_etag() -> None:
    body = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        b"<IsTruncated>false</IsTruncated><Contents>"
        b"<Key>bulk-data/citations-2026-09-30.csv.bz2</Key>"
        b"<LastModified>2026-09-30T20:24:07.000Z</LastModified>"
        b"<ETag>&quot;268d954bc431d2e090bdf200f5a40023-16&quot;</ETag>"
        b"<Size>127468518</Size></Contents></ListBucketResult>"
    )
    (entry,), token = parse_page(body)
    assert token is None
    assert entry.etag == '"268d954bc431d2e090bdf200f5a40023-16"'
    assert (entry.table, entry.size) == ("citations", 127468518)


def test_complete_exports_newest_first() -> None:
    entries = [*_export("2025-12-31"), *_export("2026-09-30"), *_export("2026-06-30")]
    assert complete_exports(entries) == [date(2026, 9, 30), date(2026, 6, 30), date(2025, 12, 31)]


def test_complete_exports_skips_a_placeholder_date() -> None:
    # Every table dated 2024-03-01 is a 14-byte placeholder.
    entries = [*_export("2024-03-01", size=14), *_export("2024-03-11")]
    assert complete_exports(entries) == [date(2024, 3, 11)]


def test_complete_exports_skips_a_date_with_one_placeholder_table() -> None:
    entries = [*_export("2026-09-30")[:-1], _entry("citations", "2026-09-30", 14)]
    assert complete_exports(entries) == []


def test_complete_exports_skips_a_date_missing_one_table() -> None:
    # The tables of an export land hours apart; until the last one does, it isn't complete.
    entries = [*_export("2026-06-30"), *_export("2026-09-30")[1:]]
    assert complete_exports(entries) == [date(2026, 6, 30)]


def test_complete_exports_asks_only_for_the_requested_tables() -> None:
    entries = [*_export("2026-06-30"), _entry("citation-map", "2026-06-30")]
    entries += _export("2026-09-30")
    assert complete_exports(entries, [*DEFAULT_TABLES, "citation-map"]) == [date(2026, 6, 30)]
    assert complete_exports(entries, ["citations"]) == [date(2026, 9, 30), date(2026, 6, 30)]


def test_complete_exports_knows_the_small_tables_arent_placeholders() -> None:
    # courts was 81 KB and people-db-people 456 KB on 2026-09-30; placeholders are 14 bytes.
    entries = [
        _entry("courts", "2026-09-30", 81226),
        _entry("people-db-people", "2026-09-30", 456021),
    ]
    entries += [_entry("courts", "2024-03-01", 14), _entry("people-db-people", "2024-03-01", 14)]
    assert complete_exports(entries, ["courts", "people-db-people"]) == [date(2026, 9, 30)]
    assert min_bytes_for("courts") == 10_000
    assert min_bytes_for("courts", 100) == 100
    assert min_bytes_for("opinions") == 1_000_000


def test_complete_exports_honors_min_bytes() -> None:
    entries = _export("2026-09-30", size=500)
    assert complete_exports(entries) == []
    assert complete_exports(entries, min_bytes=100) == [date(2026, 9, 30)]


def test_export_entries_in_requested_order_and_names_a_missing_table() -> None:
    entries = _export("2026-09-30")
    found = export_entries(entries, date(2026, 9, 30), ["citations", "opinions"])
    assert list(found) == ["citations", "opinions"]
    with pytest.raises(FileNotFoundError, match="bulk-data/courts-2026-09-30.csv.bz2"):
        export_entries(entries, date(2026, 9, 30), ["courts"])
