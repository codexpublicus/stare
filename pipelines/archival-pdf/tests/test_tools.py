from pathlib import Path

import pytest
from tools import verapdf_command

from stare_archival.images import PINNED_VERAPDF_IMAGE


def test_verapdf_docker_mode_uses_the_pinned_image_without_probing(tmp_path):
    cmd = verapdf_command(tmp_path / "x.pdf", env={"STARE_VERAPDF": "docker", "PATH": ""})
    assert cmd[:2] == ["docker", "run"]
    assert PINNED_VERAPDF_IMAGE in cmd
    assert cmd[-1] == "/work/x.pdf"
    assert cmd[cmd.index("--flavour") + 1] == "3b"


def test_verapdf_none_skips(tmp_path):
    with pytest.raises(pytest.skip.Exception):
        verapdf_command(tmp_path / "x.pdf", env={"STARE_VERAPDF": "none"})


def test_verapdf_prefers_a_binary_on_path(tmp_path):
    exe = tmp_path / "verapdf"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    cmd = verapdf_command(Path("/x/y.pdf"), env={"PATH": str(tmp_path)})
    assert cmd[0] == str(exe)
    assert cmd[-1] == "/x/y.pdf"


def test_verapdf_skips_without_a_validator(tmp_path):
    with pytest.raises(pytest.skip.Exception):
        verapdf_command(tmp_path / "x.pdf", env={"PATH": str(tmp_path)})
