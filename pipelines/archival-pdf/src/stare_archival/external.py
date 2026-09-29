"""The external tools verification runs: poppler's pdfimages and pdftotext, and veraPDF.

Poppler comes from PATH (the pipeline image installs poppler-utils). veraPDF comes from
$STARE_VERAPDF, PATH, or the pinned container image, the same way `Jbig2Encoder.locate` finds
jbig2.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from functools import cached_property
from pathlib import Path

from stare_archival.errors import ToolError
from stare_archival.images import PINNED_VERAPDF_IMAGE

VERAPDF_ARGS = ("--flavour", "3b", "--format", "text")
_POPPLER_VERSION = re.compile(r"version (\S+)")


def run_tool(
    argv: Sequence[str], *, timeout: float, stdin: bytes = b""
) -> subprocess.CompletedProcess[bytes]:
    """Run an external tool; a tool that can't start or times out is a ToolError."""
    try:
        return subprocess.run(  # noqa: S603 (argv built from located tools, no shell)
            list(argv), input=stdin, capture_output=True, check=False, timeout=timeout
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ToolError(f"could not run {argv[0]}: {exc}") from exc


def _first_line(proc: subprocess.CompletedProcess[bytes]) -> str:
    text = (proc.stdout + proc.stderr).decode(errors="replace").strip()
    return text.splitlines()[0].strip() if text else ""


class Poppler:
    """poppler's pdfimages (the JBIG2 decoder of record) and pdftotext."""

    def __init__(self, pdfimages: str, pdftotext: str, *, timeout: float = 1800.0) -> None:
        self.pdfimages = pdfimages
        self.pdftotext = pdftotext
        self.timeout = timeout

    @classmethod
    def locate(cls, env: Mapping[str, str] | None = None) -> Poppler | None:
        """Both tools from PATH, or None when either is missing."""
        env = os.environ if env is None else env
        search_path = env.get("PATH", "")
        pdfimages = shutil.which("pdfimages", path=search_path)
        pdftotext = shutil.which("pdftotext", path=search_path)
        if pdfimages is None or pdftotext is None:
            return None
        return cls(pdfimages, pdftotext)

    def _version_line(self, binary: str) -> str:
        proc = run_tool([binary, "-v"], timeout=60)
        line = _first_line(proc)
        if proc.returncode != 0 or not line:
            raise ToolError(f"{binary} -v failed: {line or proc.returncode}")
        return line

    @cached_property
    def pdfimages_version(self) -> str:
        """e.g. "pdfimages version 24.02.0"."""
        return self._version_line(self.pdfimages)

    @cached_property
    def pdftotext_version(self) -> str:
        return self._version_line(self.pdftotext)

    @property
    def version(self) -> str:
        """e.g. "poppler 24.02.0", from pdfimages."""
        m = _POPPLER_VERSION.search(self.pdfimages_version)
        return f"poppler {m.group(1)}" if m else self.pdfimages_version

    def tool_versions(self) -> dict[str, str]:
        return {"pdfimages": self.pdfimages_version, "pdftotext": self.pdftotext_version}

    def run(self, argv: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
        """Run a poppler command; a non-zero exit is a ToolError naming the tool."""
        proc = run_tool(argv, timeout=self.timeout)
        if proc.returncode != 0:
            err = proc.stderr.decode(errors="replace").strip()
            raise ToolError(f"{Path(argv[0]).name} exited {proc.returncode}: {err}")
        return proc


def parse_verapdf_text(text: str) -> bool | None:
    """The verdict in veraPDF's `--format text` output: True for PASS, False for FAIL, None
    when there's no verdict line (veraPDF didn't get as far as validating)."""
    for line in text.splitlines():
        word = line.split(" ", 1)[0]
        if word in ("PASS", "FAIL"):
            return word == "PASS"
    return None


class VeraPdf:
    """veraPDF, validating PDF/A-3b: a local binary, or the pinned image run by Docker with
    no network, as the calling user, and the PDF's directory mounted read-only."""

    def __init__(
        self,
        binary: str | None = None,
        *,
        docker_image: str | None = None,
        docker_bin: str = "docker",
        timeout: float = 1800.0,
    ) -> None:
        if (binary is None) == (docker_image is None):
            raise ValueError("give exactly one of binary and docker_image")
        self.binary = binary
        self.docker_image = docker_image
        self.docker_bin = docker_bin
        self.timeout = timeout

    @classmethod
    def docker(cls, image: str = PINNED_VERAPDF_IMAGE, docker_bin: str = "docker") -> VeraPdf:
        return cls(docker_image=image, docker_bin=docker_bin)

    @classmethod
    def locate(cls, env: Mapping[str, str] | None = None) -> VeraPdf | None:
        """$STARE_VERAPDF ("docker" for the pinned image without probing for it, "none" to
        opt out, or a binary path), then verapdf on PATH, then the pinned image if Docker has
        it locally (never pulled here). None when there's no veraPDF."""
        env = os.environ if env is None else env
        search_path = env.get("PATH", "")
        docker_bin = shutil.which("docker", path=search_path)
        chosen = env.get("STARE_VERAPDF")
        if chosen == "none":
            return None
        if chosen == "docker":
            return cls.docker(docker_bin=docker_bin or "docker")
        if chosen:
            if not (os.path.isfile(chosen) and os.access(chosen, os.X_OK)):
                raise ToolError(f"STARE_VERAPDF={chosen!r} is not an executable file")
            return cls(chosen)
        local = shutil.which("verapdf", path=search_path)
        if local is not None:
            return cls(local)
        if docker_bin is not None and _docker_has_image(docker_bin, PINNED_VERAPDF_IMAGE):
            return cls.docker(docker_bin=docker_bin)
        return None

    def _argv(self, args: Sequence[str], mount: Path | None = None) -> list[str]:
        if self.docker_image is None:
            return [self.binary or "verapdf", *args]
        volume = ["-v", f"{mount}:/work:ro"] if mount is not None else []
        return [
            self.docker_bin,
            "run",
            "--rm",
            "--network=none",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            *volume,
            self.docker_image,
            *args,
        ]

    def command(self, pdf: Path) -> list[str]:
        """The argv that validates `pdf` as PDF/A-3b."""
        pdf = Path(pdf)
        if self.docker_image is None:
            return self._argv([*VERAPDF_ARGS, str(pdf)])
        return self._argv([*VERAPDF_ARGS, f"/work/{pdf.name}"], mount=pdf.resolve().parent)

    @cached_property
    def version(self) -> str:
        """veraPDF's own version line, e.g. "veraPDF 1.30.2"."""
        proc = run_tool(self._argv(["--version"]), timeout=300)
        line = _first_line(proc)
        if proc.returncode != 0 or not line:
            raise ToolError(f"verapdf --version failed: {line or proc.returncode}")
        return line

    def tool_versions(self) -> dict[str, str]:
        versions = {"verapdf": self.version}
        if self.docker_image is not None:
            versions["verapdf_image"] = self.docker_image
        return versions

    def validate(self, pdf: Path) -> tuple[bool, str]:
        """(passed, veraPDF's output). Output with no PASS/FAIL verdict is a ToolError."""
        proc = run_tool(self.command(pdf), timeout=self.timeout)
        out = proc.stdout.decode(errors="replace").strip()
        verdict = parse_verapdf_text(out)
        if verdict is None:
            err = proc.stderr.decode(errors="replace").strip()
            raise ToolError(f"veraPDF gave no verdict (exit {proc.returncode}): {err or out}")
        return verdict, out


def _docker_has_image(docker_bin: str, image: str) -> bool:
    try:
        probe = run_tool([docker_bin, "image", "inspect", image], timeout=30)
    except ToolError:
        return False
    return probe.returncode == 0
