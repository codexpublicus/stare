import bz2
import io
import json
from datetime import date
from pathlib import Path

import pytest
from fakes3 import Bucket, objects

from stare_courtlistener import cli
from stare_courtlistener.listing import table_key

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(name="bucket")
def bucket_fixture(monkeypatch: pytest.MonkeyPatch) -> Bucket:
    """The fake bucket, with 2026-06-30 complete and 2026-09-30 missing its opinions."""
    contents = {**objects("2026-06-30"), **objects("2026-09-30")}
    del contents["bulk-data/opinions-2026-09-30.csv.bz2"]
    contents["bulk-data/citations-2024-03-01.csv.bz2"] = b"14 byte stub.."
    fake = Bucket(contents)
    monkeypatch.setattr(cli, "_client", fake.client)
    return fake


def _run(*argv: str) -> tuple[int, str]:
    out = io.StringIO()
    code = cli.main(list(argv), out=out)
    return code, out.getvalue()


@pytest.mark.usefixtures("bucket")
def test_dates_lists_complete_exports() -> None:
    code, out = _run("dates", "--min-bytes", "100")
    assert code == 0
    assert out.splitlines()[0].startswith("2026-06-30")
    assert len(out.splitlines()) == 1
    code, out = _run("dates", "--min-bytes", "100", "--all")
    assert out.splitlines()[0].startswith("2026-09-30")
    assert "opinions missing" in out and "(incomplete)" in out
    code, out = _run("dates", "--min-bytes", "100", "--all", "--tables", "citations")
    assert "citations placeholder (14 B)" in out


@pytest.mark.usefixtures("bucket")
def test_fetch_latest_complete_then_verify(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STARE_CL_DIR", str(tmp_path))
    code, out = _run("fetch", "--min-bytes", "100")
    assert code == 0, out
    assert "2026-06-30" in out
    manifest = json.loads((tmp_path / "2026-06-30" / "export.json").read_text())
    assert len(manifest["tables"]) == 4
    code, out = _run("verify", "--date", "2026-06-30")
    assert (code, out.splitlines()[-1]) == (0, "PASS")
    (tmp_path / "2026-06-30" / "dockets-2026-06-30.csv.bz2").write_bytes(b"x")
    code, out = _run("verify", "--date", "2026-06-30", "--dest", str(tmp_path))
    assert code == 1
    assert "FAIL  dockets:" in out


def test_fetch_one_table_of_a_named_date(bucket: Bucket, tmp_path: Path) -> None:
    code, _ = _run(
        "fetch",
        "--date",
        "2026-09-30",
        "--tables",
        "citations",
        "--dest",
        str(tmp_path),
        "--min-bytes",
        "100",
    )
    assert code == 0
    assert (tmp_path / "2026-09-30" / "citations-2026-09-30.csv.bz2").read_bytes() == (
        bucket.objects[table_key("citations", date(2026, 9, 30))]
    )


@pytest.mark.usefixtures("bucket")
def test_fetch_fails_in_one_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.delenv("STARE_CL_DIR", raising=False)
    assert _run("fetch")[0] == 2
    assert "STARE_CL_DIR" in capsys.readouterr().err
    assert _run("fetch", "--date", "2026-09-30", "--dest", str(tmp_path))[0] == 2
    err = capsys.readouterr().err
    assert err.count("\n") == 1 and "opinions-2026-09-30.csv.bz2" in err
    assert _run("fetch", "--tables", "nope", "--dest", str(tmp_path))[0] == 2
    assert "unknown table nope" in capsys.readouterr().err


def test_head_prints_rows_as_json_with_long_values_cut(tmp_path: Path) -> None:
    directory = tmp_path / "2026-09-30"
    directory.mkdir()
    src = FIXTURES / "opinions-2026-09-30.csv"
    (directory / "opinions-2026-09-30.csv.bz2").write_bytes(bz2.compress(src.read_bytes()))
    code, out = _run(
        "head", "--table", "opinions", "--date", "2026-09-30", "--dest", str(tmp_path), "-n", "2"
    )
    assert code == 0
    rows = [json.loads(line) for line in out.splitlines()]
    assert len(rows) == 2
    assert rows[0]["id"] == "7090799"
    assert rows[0]["author_id"] is None
    assert rows[0]["xml_harvard"].startswith('<opinion type="majority">')
    assert rows[0]["xml_harvard"].endswith(" chars)")
    assert len(rows[0]["xml_harvard"]) < 250


def test_head_names_a_missing_file(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    code, _ = _run("head", "--table", "dockets", "--date", "2026-09-30", "--dest", str(tmp_path))
    assert code == 2
    assert "dockets-2026-09-30.csv.bz2 doesn't exist" in capsys.readouterr().err
