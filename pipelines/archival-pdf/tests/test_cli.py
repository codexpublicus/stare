import io
import json
from datetime import UTC, datetime
from importlib.metadata import entry_points
from pathlib import Path

import pikepdf
import pytest
from fixture_paths import FIXTURES

from stare_archival.build import build_volume
from stare_archival.cli import main
from stare_archival.encoders import G4Encoder

CREATED = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)


def test_console_script_is_declared():
    (ep,) = [e for e in entry_points(group="console_scripts") if e.name == "stare-archival"]
    assert ep.value == "stare_archival.cli:main"


def test_help_lists_verify(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--help"])
    assert exc.value.code == 0
    assert "verify" in capsys.readouterr().out


@pytest.fixture(scope="module")
def pdf(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("cli") / "152.pdf"
    build_volume(FIXTURES / "152.tar", None, out, G4Encoder(), volume_id="a2d/152", created=CREATED)
    return out


def _run(args: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = main(args, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


@pytest.mark.poppler
def test_verify_passes_and_writes_the_manifest(pdf, tmp_path):
    manifest = tmp_path / "152.json"
    code, out, err = _run(
        [
            "verify",
            str(pdf),
            "--tar",
            str(FIXTURES / "152.tar"),
            "--manifest",
            str(manifest),
            "--generated",
            "2026-09-29T12:00:00Z",
        ]
    )
    assert (code, err) == (0, "")
    assert out.splitlines()[-1] == "PASS a2d/152 (4 pages)"
    m = json.loads(manifest.read_text())
    assert m["status"] == "pass"
    assert m["generated"] == "2026-09-29T12:00:00Z"
    assert m["output"]["sha256"]


@pytest.mark.poppler
def test_verify_json_prints_the_manifest(pdf):
    code, out, _ = _run(["verify", str(pdf), "--tar", str(FIXTURES / "152.tar"), "--json"])
    assert code == 0
    assert json.loads(out)["volume_id"] == "a2d/152"


@pytest.mark.poppler
def test_verify_failure_names_the_check_and_page(pdf, tmp_path):
    bad = tmp_path / "bad.pdf"
    with pikepdf.open(pdf) as doc:
        page = doc.pages[1]
        page.Contents.write(page.Contents.read_bytes().replace(b"3 Tr", b"0 Tr", 1))
        doc.save(bad)
    code, out, _ = _run(["verify", str(bad), "--tar", str(FIXTURES / "152.tar")])
    assert code == 1
    lines = out.splitlines()
    # visible text fails both the page's drawing check and the exact layer check
    assert lines[-1] == "FAIL a2d/152 (4 pages): 2 failures"
    assert any(line.startswith("text_layer: page 2 (order 871, label 839): ") for line in lines)
    assert any(line.startswith("image_streams: page 2 (order 871, label 839): ") for line in lines)


@pytest.mark.poppler
def test_verify_error_exits_2(tmp_path):
    (tmp_path / "junk.pdf").write_bytes(b"not a pdf")
    code, out, err = _run(
        ["verify", str(tmp_path / "junk.pdf"), "--tar", str(FIXTURES / "152.tar")]
    )
    assert code == 2
    assert "junk.pdf" in err


@pytest.mark.poppler
def test_verify_a_missing_tar_exits_2(pdf, tmp_path):
    code, out, err = _run(["verify", str(pdf), "--tar", str(tmp_path / "nope.tar")])
    assert code == 2
    assert "nope.tar" in err and "Traceback" not in err


def test_a_naive_generated_time_is_rejected_before_verifying(tmp_path):
    # the tar doesn't exist either: the timestamp must be the error reported
    code, _, err = _run(
        [
            "verify",
            str(tmp_path / "x.pdf"),
            "--tar",
            str(tmp_path / "nope.tar"),
            "--generated",
            "2026-09-29T12:00:00",
        ]
    )
    assert code == 2
    assert "--generated" in err and "timezone" in err
