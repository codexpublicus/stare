import hashlib
import io
import json
import shutil
from pathlib import Path

import pytest
from fixture_paths import FIXTURES

from stare_archival.cli import main
from stare_archival.manifest import read_manifest


def _run(args: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    code = main(args, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


@pytest.fixture
def src(tmp_path) -> Path:
    s = tmp_path / "downloads"
    for ref in ("a2d/152", "us/10"):
        reporter, volume = ref.split("/")
        (s / reporter).mkdir(parents=True, exist_ok=True)
        shutil.copyfile(FIXTURES / "152.tar", s / reporter / f"{volume}.tar")
        shutil.copyfile(FIXTURES / "152.tar.csv", s / reporter / f"{volume}.tar.csv")
    digest = hashlib.sha256((FIXTURES / "152.tar").read_bytes()).hexdigest()
    (s / "a2d" / "152.tar.sha256").write_text(digest)
    return s


def test_help_lists_build_and_build_all(capsys):
    with pytest.raises(SystemExit):
        main(["--help"])
    text = capsys.readouterr().out
    assert "build-all" in text and "build" in text


@pytest.mark.poppler
def test_build_one_volume(src, tmp_path):
    out = tmp_path / "out"
    code, stdout, err = _run(
        ["build", "a2d/152", "--src", str(src), "--out", str(out), "--encoder", "g4"]
    )
    assert (code, err) == (0, "")
    assert stdout.startswith("PASS a2d/152")
    assert (out / "cap-pdf/a2d/152.pdf").is_file()
    assert read_manifest(out / "cap-pdf/_manifests/a2d/152.json")["status"] == "pass"
    code, stdout, _ = _run(
        ["build", "a2d/152", "--src", str(src), "--out", str(out), "--encoder", "g4"]
    )
    assert code == 0
    assert stdout.startswith("SKIPPED a2d/152")


def test_build_an_unknown_volume_exits_2(src, tmp_path):
    code, _, err = _run(
        ["build", "a2d/999", "--src", str(src), "--out", str(tmp_path), "--encoder", "g4"]
    )
    assert code == 2
    assert "a2d/999" in err


@pytest.mark.poppler
def test_build_all_writes_a_run_summary_and_resumes(src, tmp_path, monkeypatch):
    monkeypatch.setenv("STARE_ARCHIVAL_IMAGE", "stare-archival@sha256:" + "d" * 64)
    out = tmp_path / "out"
    args = ["build-all", "--src", str(src), "--out", str(out), "--encoder", "g4", "--jobs", "2"]
    code, stdout, err = _run(args)
    assert code == 0, err
    assert "pass 2" in stdout
    (summary_path,) = (out / "runs").glob("*.json")
    summary = json.loads(summary_path.read_text())
    assert summary["counts"]["pass"] == 2
    assert summary["ok"] is True
    assert summary["settings"]["jobs"] == 2
    assert summary["settings"]["pipeline_image"] == "stare-archival@sha256:" + "d" * 64
    m = read_manifest(out / "cap-pdf/_manifests/us/10.json")
    assert m["pins"] == {"pipeline": "stare-archival@sha256:" + "d" * 64}
    code, stdout, _ = _run(args)
    assert code == 0
    assert "skipped 2" in stdout


@pytest.mark.poppler
def test_build_all_only_and_limit(src, tmp_path):
    out = tmp_path / "out"
    base = ["build-all", "--src", str(src), "--out", str(out), "--encoder", "g4"]
    code, stdout, _ = _run([*base, "--only", "us"])
    assert code == 0
    assert "selected 1" in stdout
    assert (out / "cap-pdf/us/10.pdf").is_file()
    assert not (out / "cap-pdf/a2d").exists()
    code, stdout, _ = _run([*base, "--limit", "1"])
    assert "selected 1" in stdout
    assert (out / "cap-pdf/a2d/152.pdf").is_file()


def test_build_all_with_an_unknown_only_exits_2(src, tmp_path):
    code, _, err = _run(
        [
            "build-all",
            "--src",
            str(src),
            "--out",
            str(tmp_path),
            "--only",
            "nope",
            "--encoder",
            "g4",
        ]
    )
    assert code == 2
    assert "nope" in err


def test_the_batch_refuses_jbig2_in_docker(src, tmp_path, monkeypatch):
    monkeypatch.setenv("STARE_JBIG2", "docker")
    for cmd in (["build", "a2d/152"], ["build-all"]):
        code, _, err = _run([*cmd, "--src", str(src), "--out", str(tmp_path)])
        assert code == 2
        assert "docker" in err


def test_the_batch_needs_a_native_jbig2(src, tmp_path, monkeypatch):
    monkeypatch.setenv("STARE_JBIG2", "none")
    code, _, err = _run(["build-all", "--src", str(src), "--out", str(tmp_path)])
    assert code == 2
    assert "jbig2" in err and "--encoder g4" in err


def test_a_bad_max_local_bytes_exits_2(src, tmp_path):
    with pytest.raises(SystemExit) as exc:
        _run(
            [
                "build-all",
                "--src",
                str(src),
                "--out",
                str(tmp_path),
                "--encoder",
                "g4",
                "--max-local-bytes",
                "lots",
            ]
        )
    assert exc.value.code == 2
