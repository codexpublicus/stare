"""The export's CSV dialect, against fixtures cut from the 2026-09-30 export.

The fixtures (``scripts/cut_fixtures.py``) keep each table's real header and real records:
PostgreSQL ``COPY ... CSV`` with every non-null value quoted, null as an empty unquoted
field, and a quote or backslash inside a value escaped with a backslash, never doubled.
"""

import bz2
import csv
import sys
from pathlib import Path

import pytest

from stare_courtlistener import table as table_module
from stare_courtlistener.table import FIELD_SIZE_LIMIT, open_table, read_table

FIXTURES = Path(__file__).parent / "fixtures"
TABLES = ("opinion-clusters", "opinions", "dockets", "citations", "citation-map")
WIDTHS = {"opinion-clusters": 36, "opinions": 22, "dockets": 54, "citations": 8, "citation-map": 4}


def _rows(table: str) -> dict[str, dict[str, str | None]]:
    with open_table(FIXTURES / f"{table}-2026-09-30.csv") as fh:
        return {row["id"]: row for row in read_table(fh, table)}


@pytest.mark.parametrize("table", TABLES)
def test_every_fixture_reads_whole(table: str) -> None:
    rows = _rows(table)
    assert len(rows) >= 3
    assert all(len(row) == WIDTHS[table] for row in rows.values())


def test_escaped_quote_reads_back() -> None:
    dockets = _rows("dockets")
    assert '"' in dockets["74274066"]["case_name"]
    clusters = _rows("opinion-clusters")
    assert clusters["3282271"]["headmatter"].count('"') > 0


def test_escaped_backslash_reads_back_as_one() -> None:
    summary = _rows("opinion-clusters")["6720952"]["summary"]
    assert "St. P. R\\y Go., 33 id., 67." in summary
    assert "\\\\" not in summary
    xml = _rows("opinions")["7090799"]["xml_harvard"]
    assert "<em>to the plaintiff himself\\ </em>" in xml


def test_embedded_newlines_and_carriage_returns_stay_in_the_field() -> None:
    clusters = _rows("opinion-clusters")
    assert clusters["86605"]["case_name"] == "James Trigg v. Thomas S. Drew\r\n"
    assert "\n" in clusters["3282271"]["posture"]
    assert "\n" in _rows("opinions")["7090799"]["html_with_citations"]


def test_null_and_empty_string_stay_distinct() -> None:
    opinion = _rows("opinions")["7090799"]
    assert opinion["author_id"] is None
    assert opinion["download_url"] is None
    assert opinion["joined_by_str"] == ""
    assert opinion["per_curiam"] == "f"
    assert _rows("opinion-clusters")["5561318"]["date_blocked"] is None


def test_columns_picks_and_orders() -> None:
    with open_table(FIXTURES / "citations-2026-09-30.csv") as fh:
        first = next(read_table(fh, "citations", ["cluster_id", "volume", "reporter", "page"]))
    assert first == {"cluster_id": "10710637", "volume": "2025", "reporter": "OK", "page": "74"}


def test_fields_far_past_the_default_limit(tmp_path: Path) -> None:
    # The opinions table's HTML columns pass 750 KB; Python's default limit is 128 KB.
    big = 'x\\"' * 100_000 + "\n" * 1000 + "y" * 500_000  # > 800 KB, escapes and newlines
    escaped = big.replace("\\", "\\\\").replace('"', '\\"')
    path = tmp_path / "opinions.csv"
    path.write_text(f'id,html,cluster_id\n"1","{escaped}","7"\n', encoding="utf-8")
    with path.open(encoding="utf-8", newline="") as fh:
        (row,) = read_table(fh, "opinions")
    assert row == {"id": "1", "html": big, "cluster_id": "7"}


def test_a_row_of_the_wrong_width_names_its_record(tmp_path: Path) -> None:
    path = tmp_path / "dockets.csv"
    path.write_text('id,court_id\n"1","ca10"\n"2","ca10","extra"\n', encoding="utf-8")
    with (
        path.open(encoding="utf-8", newline="") as fh,
        pytest.raises(ValueError, match=r"dockets: record 2 \(line 3\) has 3 fields, expected 2"),
    ):
        list(read_table(fh, "dockets"))


def test_pythons_default_dialect_misreads_the_export() -> None:
    # The reason for ExportDialect: the default reads \" as a closing quote and splits rows.
    csv.field_size_limit(FIELD_SIZE_LIMIT)
    with (FIXTURES / "dockets-2026-09-30.csv").open(encoding="utf-8", newline="") as fh:
        widths = [len(row) for row in csv.reader(fh)]
    assert widths == [54, 54, 54, 54, 55]
    assert {len(row) for row in _rows("dockets").values()} == {54}


def test_a_truncated_file_is_an_error(tmp_path: Path) -> None:
    text = (FIXTURES / "opinions-2026-09-30.csv").read_text(encoding="utf-8")
    path = tmp_path / "opinions.csv"
    path.write_text(text[: len(text) // 2], encoding="utf-8")
    with path.open(encoding="utf-8", newline="") as fh, pytest.raises(ValueError, match="opinions"):
        list(read_table(fh, "opinions"))


def test_a_missing_column_and_an_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "dockets.csv"
    path.write_text('id,court\n"1","ca10"\n', encoding="utf-8")
    with path.open(encoding="utf-8", newline="") as fh, pytest.raises(ValueError, match="lacks"):
        list(read_table(fh, "dockets", ["id", "court_id"]))
    path.write_text("", encoding="utf-8")
    with path.open(encoding="utf-8", newline="") as fh, pytest.raises(ValueError, match="empty"):
        list(read_table(fh, "dockets"))


# --- open_table ---------------------------------------------------------------------------


def _bz2(tmp_path: Path, table: str) -> Path:
    path = tmp_path / f"{table}-2026-09-30.csv.bz2"
    path.write_bytes(bz2.compress((FIXTURES / f"{table}-2026-09-30.csv").read_bytes()))
    return path


def _read_all(path: Path, table: str) -> list[dict[str, str | None]]:
    with open_table(path) as fh:
        return list(read_table(fh, table))


def test_open_table_with_pythons_bz2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(table_module, "_decompress_command", lambda: None)
    path = _bz2(tmp_path, "opinion-clusters")
    assert _read_all(path, "opinion-clusters") == list(_rows("opinion-clusters").values())


_FAKE_LBZIP2 = (
    "import bz2, shutil, sys; shutil.copyfileobj(bz2.open(sys.argv[1]), sys.stdout.buffer)"
)


def test_open_table_through_an_external_decompressor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        table_module, "_decompress_command", lambda: [sys.executable, "-c", _FAKE_LBZIP2]
    )
    path = _bz2(tmp_path, "opinions")
    assert _read_all(path, "opinions") == list(_rows("opinions").values())


def test_open_table_reports_a_failing_decompressor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = (
        "import sys; sys.stdout.write('id\\n\"1\"\\n'); sys.stderr.write('bad block'); sys.exit(3)"
    )
    monkeypatch.setattr(table_module, "_decompress_command", lambda: [sys.executable, "-c", script])
    path = _bz2(tmp_path, "citations")
    with pytest.raises(OSError, match=r"failed on .*\(exit 3\): bad block"):
        _read_all(path, "citations")


def test_open_table_stops_the_decompressor_when_the_reader_stops_early(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A decompressor with far more to say than the reader wants (head -n 1).
    script = (
        "import sys\nsys.stdout.write('id\\n')\nwhile True: sys.stdout.write('\"1\"\\n' * 10000)"
    )
    monkeypatch.setattr(table_module, "_decompress_command", lambda: [sys.executable, "-c", script])
    path = _bz2(tmp_path, "citations")
    with open_table(path) as fh:
        first = next(read_table(fh, "citations"))
    assert first == {"id": "1"}
