"""Locate the optional external tools some tests need; tests that can't find them skip."""

from __future__ import annotations

import os
import shutil
from collections.abc import Mapping
from pathlib import Path

import pytest

from stare_archival.external import VeraPdf


def require(binary: str) -> str:
    """Path of `binary` on PATH, or skip the test."""
    found = shutil.which(binary)
    if found is None:
        pytest.skip(f"{binary} is not on PATH")
    return found


def verapdf_tool(env: Mapping[str, str] | None = None) -> VeraPdf:
    """The veraPDF validator `VeraPdf.locate` finds, or skip the test.

    $STARE_VERAPDF picks it: "docker" runs the pinned image without probing for it (CI sets
    this, so a missing image fails the test rather than skipping it), "none" skips, and
    anything else is a verapdf binary. Unset: verapdf on PATH, else the pinned image if
    Docker has it locally.
    """
    env = os.environ if env is None else env
    if env.get("STARE_VERAPDF") == "none":
        pytest.skip("STARE_VERAPDF=none")
    found = VeraPdf.locate(env=env)
    if found is None:
        pytest.skip("veraPDF is not available (no verapdf on PATH, no pinned image)")
    return found


def verapdf_command(pdf: Path, env: Mapping[str, str] | None = None) -> list[str]:
    """A veraPDF command that validates `pdf` as PDF/A-3b, or skip the test."""
    return verapdf_tool(env).command(pdf)
