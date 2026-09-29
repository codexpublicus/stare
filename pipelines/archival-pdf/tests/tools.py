"""Locate the optional external tools some tests need; tests that can't find them skip."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

VERAPDF_IMAGES = ("verapdf/cli:latest", "ghcr.io/verapdf/cli:latest")


def require(binary: str) -> str:
    """Path of `binary` on PATH, or skip the test."""
    found = shutil.which(binary)
    if found is None:
        pytest.skip(f"{binary} is not on PATH")
    return found


def _docker_has_image(image: str) -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(["docker", "image", "inspect", image], capture_output=True, check=False)
    return probe.returncode == 0


def verapdf_command(pdf: Path) -> list[str]:
    """A veraPDF command that validates `pdf` as PDF/A-3b, or skip the test."""
    local = shutil.which("verapdf")
    if local is not None:
        return [local, "--flavour", "3b", "--format", "text", str(pdf)]
    for image in VERAPDF_IMAGES:
        if _docker_has_image(image):
            return [
                "docker",
                "run",
                "--rm",
                "--network=none",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                "-v",
                f"{pdf.parent}:/work:ro",
                image,
                "--flavour",
                "3b",
                "--format",
                "text",
                f"/work/{pdf.name}",
            ]
    pytest.skip("veraPDF is not available (no verapdf on PATH, no local verapdf/cli image)")
