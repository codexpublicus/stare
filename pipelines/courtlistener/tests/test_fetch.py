import hashlib
import json
from datetime import UTC, date, datetime
from pathlib import Path

import httpx
import pytest
from fakes3 import Bucket, etag, objects

from stare_courtlistener import fetch as fetch_module
from stare_courtlistener.fetch import (
    TERMS,
    ObjectChangedError,
    backoff,
    fetch_export,
    verify_export,
)
from stare_courtlistener.listing import DEFAULT_TABLES, table_key

DATE = date(2026, 9, 30)
NOW = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)


def _fetch(bucket: Bucket, dest: Path, **kwargs) -> Path:
    kwargs.setdefault("min_bytes", 1)
    kwargs.setdefault("sleep", lambda _s: None)
    return fetch_export(DATE, dest, bucket.client(), now=lambda: NOW, **kwargs)


def _file(dest: Path, table: str) -> Path:
    return dest / "2026-09-30" / f"{table}-2026-09-30.csv.bz2"


def _partial(dest: Path, table: str, data: bytes, tag: str | None) -> None:
    """A ``.part`` (and its ETag sidecar) as an interrupted fetch leaves them."""
    final = _file(dest, table)
    final.parent.mkdir(parents=True, exist_ok=True)
    final.with_name(final.name + ".part").write_bytes(data)
    if tag is not None:
        final.with_name(final.name + ".part.etag").write_text(tag + "\n", encoding="utf-8")


def test_fetch_downloads_each_table_and_records_it(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    directory = _fetch(bucket, tmp_path)
    assert directory == tmp_path / "2026-09-30"
    manifest = json.loads((directory / "export.json").read_text(encoding="utf-8"))
    assert manifest["date"] == "2026-09-30"
    assert manifest["terms"] == TERMS
    assert manifest["terms"]["statement"] == (
        "Our bulk data files are free of known copyright restrictions."
    )
    assert list(manifest["tables"]) == list(DEFAULT_TABLES)
    for table in DEFAULT_TABLES:
        data = bucket.objects[table_key(table, DATE)]
        assert _file(tmp_path, table).read_bytes() == data
        assert manifest["tables"][table] == {
            "key": table_key(table, DATE),
            "file": f"{table}-2026-09-30.csv.bz2",
            "size": len(data),
            "etag": etag(data),
            "last_modified": "2026-09-30T20:24:07.000Z",
            "sha256": hashlib.sha256(data).hexdigest(),
            "fetched_at": "2026-10-10T12:00:00+00:00",
        }
    assert not list(directory.glob("*.part*"))


def test_fetch_resumes_a_part_with_range_and_if_range(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    key = table_key("opinions", DATE)
    data = bucket.objects[key]
    _partial(tmp_path, "opinions", data[:100], etag(data))
    _fetch(bucket, tmp_path, tables=["opinions"])
    (get,) = bucket.gets(key)
    assert (get.headers["range"], get.headers["if-range"]) == ("bytes=100-", etag(data))
    assert _file(tmp_path, "opinions").read_bytes() == data


def test_fetch_restarts_on_a_200_when_the_server_ignores_the_range(tmp_path: Path) -> None:
    bucket = Bucket(objects(), ignore_range=True)
    key = table_key("citations", DATE)
    data = bucket.objects[key]
    _partial(tmp_path, "citations", b"garbage", etag(data))
    _fetch(bucket, tmp_path, tables=["citations"])
    (get,) = bucket.gets(key)
    assert get.headers["range"] == "bytes=7-"
    assert _file(tmp_path, "citations").read_bytes() == data


def test_fetch_never_splices_two_versions_of_an_object(tmp_path: Path) -> None:
    # The listing still names version A; the bucket now holds B. If-Range gets a 200 of B,
    # which is not what the listing (and so export.json) would record.
    key = table_key("citations", DATE)
    old, new = b"OLD" * 100, b"NEW" * 100
    bucket = Bucket({**objects(), key: new}, listed_etags={key: etag(old)})
    _partial(tmp_path, "citations", old[:150], etag(old))
    with pytest.raises(ObjectChangedError, match="replaced after the listing"):
        _fetch(bucket, tmp_path, tables=["citations"])
    (get,) = bucket.gets(key)
    assert get.headers["if-range"] == etag(old)
    assert not list((tmp_path / "2026-09-30").glob("citations*"))


def test_fetch_drops_a_part_on_a_206_of_another_version(tmp_path: Path) -> None:
    # A server that honors Range but ignores If-Range: the 206's ETag gives it away.
    key = table_key("citations", DATE)
    old, new = b"OLD" * 100, b"NEW" * 100
    bucket = Bucket({**objects(), key: new}, listed_etags={key: etag(old)}, ignore_if_range=True)
    _partial(tmp_path, "citations", old[:150], etag(old))
    with pytest.raises(ObjectChangedError):
        _fetch(bucket, tmp_path, tables=["citations"])
    first, second = bucket.gets(key)
    assert first.headers["range"] == "bytes=150-"
    assert "range" not in second.headers
    assert not list((tmp_path / "2026-09-30").glob("citations*"))


def test_fetch_starts_over_when_the_listing_shows_a_new_etag(tmp_path: Path) -> None:
    key = table_key("citations", DATE)
    old, new = b"OLD" * 100, b"NEW" * 100
    bucket = Bucket({**objects(), key: new})
    _partial(tmp_path, "citations", old[:150], etag(old))
    _fetch(bucket, tmp_path, tables=["citations"])
    (get,) = bucket.gets(key)
    assert "range" not in get.headers
    assert _file(tmp_path, "citations").read_bytes() == new


def test_fetch_starts_over_on_a_part_without_an_etag(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    key = table_key("dockets", DATE)
    _partial(tmp_path, "dockets", b"from an older fetch", None)
    _fetch(bucket, tmp_path, tables=["dockets"])
    (get,) = bucket.gets(key)
    assert "range" not in get.headers
    assert _file(tmp_path, "dockets").read_bytes() == bucket.objects[key]


def test_fetch_starts_over_on_a_part_larger_than_the_listing(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    data = bucket.objects[table_key("dockets", DATE)]
    _partial(tmp_path, "dockets", data + b"extra", etag(data))
    _fetch(bucket, tmp_path, tables=["dockets"])
    assert _file(tmp_path, "dockets").read_bytes() == data


def test_fetch_retries_dropped_connections_and_5xx_with_backoff(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    key = table_key("opinions", DATE)
    bucket.drop[key] = 2
    bucket.status[key] = [503]
    slept: list[float] = []
    _fetch(bucket, tmp_path, tables=["opinions"], sleep=slept.append)
    assert slept == [2.0, 4.0, 8.0]
    assert _file(tmp_path, "opinions").read_bytes() == bucket.objects[key]


def test_fetch_does_not_retry_a_4xx(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    key = table_key("opinions", DATE)
    bucket.status[key] = [403]
    with pytest.raises(httpx.HTTPStatusError):
        _fetch(bucket, tmp_path, tables=["opinions"])
    assert len(bucket.gets(key)) == 1


def test_backoff_doubles_and_caps_at_a_minute() -> None:
    assert [backoff(n) for n in range(1, 9)] == [2, 4, 8, 16, 32, 60, 60, 60]


def test_fetch_fails_a_download_that_stops_short(tmp_path: Path) -> None:
    bucket = Bucket(objects(), short=10)
    with pytest.raises(ValueError, match=r"dockets-2026-09-30.csv.bz2.part ended at \d+ bytes"):
        _fetch(bucket, tmp_path, tables=["dockets"], attempts=3)
    assert not _file(tmp_path, "dockets").exists()
    assert len(bucket.gets(table_key("dockets", DATE))) == 3


def test_fetch_skips_a_finished_file_and_keeps_its_recorded_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bucket = Bucket(objects())
    _fetch(bucket, tmp_path, tables=["citations"])
    first = json.loads((tmp_path / "2026-09-30" / "export.json").read_text())
    hashed: list[Path] = []
    real = fetch_module.sha256_file
    monkeypatch.setattr(fetch_module, "sha256_file", lambda p: hashed.append(p) or real(p))
    bucket.requests.clear()
    fetch_export(DATE, tmp_path, bucket.client(), tables=["citations"], min_bytes=1)
    assert not bucket.gets(table_key("citations", DATE))
    assert hashed == []
    second = json.loads((tmp_path / "2026-09-30" / "export.json").read_text())
    assert second["tables"] == first["tables"]


def test_fetch_keeps_tables_recorded_by_an_earlier_run(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    _fetch(bucket, tmp_path, tables=["citations"])
    _fetch(bucket, tmp_path, tables=["dockets"])
    manifest = json.loads((tmp_path / "2026-09-30" / "export.json").read_text())
    assert list(manifest["tables"]) == ["citations", "dockets"]


def test_fetch_refuses_a_finished_file_of_the_wrong_size(tmp_path: Path) -> None:
    bucket = Bucket(objects())
    _file(tmp_path, "dockets").parent.mkdir(parents=True)
    _file(tmp_path, "dockets").write_bytes(b"short")
    with pytest.raises(ValueError, match=r"dockets-2026-09-30.csv.bz2 is 5 bytes"):
        _fetch(bucket, tmp_path, tables=["dockets"])


def test_fetch_refuses_an_export_replaced_since_it_was_fetched(tmp_path: Path) -> None:
    key = table_key("citations", DATE)
    bucket = Bucket(objects())
    _fetch(bucket, tmp_path, tables=["citations"])
    bucket.objects[key] = b"X" * len(bucket.objects[key])
    with pytest.raises(ValueError, match="the export was replaced"):
        _fetch(bucket, tmp_path, tables=["citations"])


def test_fetch_refuses_a_placeholder(tmp_path: Path) -> None:
    bucket = Bucket({**objects(), table_key("citations", DATE): b"14 byte stub.."})
    with pytest.raises(ValueError, match="14-byte placeholder"):
        _fetch(bucket, tmp_path, min_bytes=100)
    assert not (tmp_path / "2026-09-30").exists()


def test_fetch_names_a_table_the_bucket_lacks(tmp_path: Path) -> None:
    contents = objects()
    del contents[table_key("opinions", DATE)]
    with pytest.raises(FileNotFoundError, match="bulk-data/opinions-2026-09-30.csv.bz2"):
        _fetch(Bucket(contents), tmp_path)


def test_verify_passes_a_fetched_export_and_catches_damage(tmp_path: Path) -> None:
    directory = _fetch(Bucket(objects()), tmp_path)
    assert verify_export(directory) == (list(DEFAULT_TABLES), [])
    citations = _file(tmp_path, "citations")
    damaged = bytearray(citations.read_bytes())
    damaged[10] ^= 0xFF
    citations.write_bytes(bytes(damaged))
    _file(tmp_path, "dockets").unlink()
    _file(tmp_path, "opinions").write_bytes(b"short")
    passed, failures = verify_export(directory)
    assert passed == ["opinion-clusters"]
    assert failures[0].startswith("opinions: opinions-2026-09-30.csv.bz2 is 5 bytes")
    assert failures[1] == "dockets: dockets-2026-09-30.csv.bz2 is missing"
    assert failures[2].startswith("citations: citations-2026-09-30.csv.bz2 has SHA-256")


def test_verify_needs_an_export_json(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="export.json"):
        verify_export(tmp_path)
