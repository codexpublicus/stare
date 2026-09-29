"""Locate the optional external tools some tests need; tests that can't find them skip."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path

import pytest

from stare_archival.images import PINNED_VERAPDF_IMAGE


def require(binary: str) -> str:
    """Path of `binary` on PATH, or skip the test."""
    found = shutil.which(binary)
    if found is None:
        pytest.skip(f"{binary} is not on PATH")
    return found


def _docker_has_image(docker: str, image: str) -> bool:
    probe = subprocess.run([docker, "image", "inspect", image], capture_output=True, check=False)
    return probe.returncode == 0


def verapdf_command(pdf: Path, env: Mapping[str, str] | None = None) -> list[str]:
    """A veraPDF command that validates `pdf` as PDF/A-3b, or skip the test.

    $STARE_VERAPDF picks the validator: "docker" runs the pinned image without probing for it
    (CI sets this, so a missing image fails the test rather than skipping it), "none" skips,
    and anything else is a verapdf binary. Unset: verapdf on PATH, else the pinned image if
    Docker has it locally.
    """
    env = os.environ if env is None else env
    search_path = env.get("PATH", "")
    args = ["--flavour", "3b", "--format", "text"]
    chosen = env.get("STARE_VERAPDF")
    if chosen == "none":
        pytest.skip("STARE_VERAPDF=none")
    docker = shutil.which("docker", path=search_path)
    if chosen and chosen != "docker":
        return [chosen, *args, str(pdf)]
    if not chosen:
        local = shutil.which("verapdf", path=search_path)
        if local is not None:
            return [local, *args, str(pdf)]
        if docker is None or not _docker_has_image(docker, PINNED_VERAPDF_IMAGE):
            pytest.skip("veraPDF is not available (no verapdf on PATH, no pinned image)")
    return [
        docker or "docker",
        "run",
        "--rm",
        "--network=none",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "-v",
        f"{pdf.parent}:/work:ro",
        PINNED_VERAPDF_IMAGE,
        *args,
        f"/work/{pdf.name}",
    ]
