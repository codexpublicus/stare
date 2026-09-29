from pathlib import Path

import pytest

from stare_archival.errors import ToolError
from stare_archival.external import Poppler, VeraPdf, parse_verapdf_text
from stare_archival.images import PINNED_VERAPDF_IMAGE


def _exe(dir_: Path, name: str, script: str) -> Path:
    path = dir_ / name
    path.write_text("#!/bin/sh\n" + script)
    path.chmod(0o755)
    return path


def test_poppler_is_found_on_the_given_path(tmp_path):
    _exe(tmp_path, "pdfimages", 'echo "pdfimages version 24.02.0" >&2\n')
    _exe(tmp_path, "pdftotext", 'echo "pdftotext version 24.02.0" >&2\n')
    poppler = Poppler.locate(env={"PATH": str(tmp_path)})
    assert poppler.pdfimages == str(tmp_path / "pdfimages")
    assert poppler.pdftotext == str(tmp_path / "pdftotext")
    assert poppler.version == "poppler 24.02.0"
    assert poppler.tool_versions() == {
        "pdfimages": "pdfimages version 24.02.0",
        "pdftotext": "pdftotext version 24.02.0",
    }


def test_poppler_needs_both_tools(tmp_path):
    _exe(tmp_path, "pdfimages", "")
    assert Poppler.locate(env={"PATH": str(tmp_path)}) is None


def test_poppler_version_failure_is_a_tool_error(tmp_path):
    poppler = Poppler(str(tmp_path / "missing-pdfimages"), str(tmp_path / "missing-pdftotext"))
    with pytest.raises(ToolError, match="missing-pdfimages"):
        _ = poppler.version


def test_verapdf_docker_mode_uses_the_pinned_image_without_probing(tmp_path):
    vera = VeraPdf.locate(env={"STARE_VERAPDF": "docker", "PATH": ""})
    cmd = vera.command(tmp_path / "x.pdf")
    assert cmd[:2] == ["docker", "run"]
    assert "--network=none" in cmd
    assert PINNED_VERAPDF_IMAGE in cmd
    assert cmd[-1] == "/work/x.pdf"
    assert cmd[cmd.index("--flavour") + 1] == "3b"


def test_verapdf_none_opts_out():
    assert VeraPdf.locate(env={"STARE_VERAPDF": "none"}) is None


def test_verapdf_prefers_a_binary_on_path(tmp_path):
    exe = _exe(tmp_path, "verapdf", "")
    vera = VeraPdf.locate(env={"PATH": str(tmp_path)})
    assert vera.command(Path("/x/y.pdf")) == [
        str(exe),
        "--flavour",
        "3b",
        "--format",
        "text",
        "/x/y.pdf",
    ]


def test_verapdf_explicit_binary_must_be_executable(tmp_path):
    with pytest.raises(ToolError, match="STARE_VERAPDF"):
        VeraPdf.locate(env={"STARE_VERAPDF": str(tmp_path / "nope")})


def test_verapdf_not_found(tmp_path):
    assert VeraPdf.locate(env={"PATH": str(tmp_path)}) is None


def test_verapdf_validate_runs_the_command_and_reads_its_verdict(tmp_path):
    exe = _exe(tmp_path, "verapdf", 'echo "PASS $5 3b"\n')
    vera = VeraPdf(str(exe))
    assert vera.validate(tmp_path / "a.pdf") == (True, f"PASS {tmp_path / 'a.pdf'} 3b")
    fail = _exe(tmp_path, "vfail", 'echo "FAIL $5 3b"; exit 1\n')
    assert VeraPdf(str(fail)).validate(tmp_path / "a.pdf")[0] is False


def test_verapdf_that_cannot_run_is_a_tool_error(tmp_path):
    broken = _exe(tmp_path, "vbroken", 'echo "java: not found" >&2; exit 127\n')
    with pytest.raises(ToolError, match="java: not found"):
        VeraPdf(str(broken)).validate(tmp_path / "a.pdf")


@pytest.mark.parametrize(
    ("text", "verdict"),
    [
        ("PASS /work/a.pdf 3b\n", True),
        ("FAIL /work/a.pdf 3b\n", False),
        ("some log line\nPASS /work/a.pdf 3b\n", True),
        ("", None),
        ("Exception in thread main\n", None),
    ],
)
def test_parse_verapdf_text(text, verdict):
    assert parse_verapdf_text(text) is verdict
