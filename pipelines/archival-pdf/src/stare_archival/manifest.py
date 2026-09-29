"""The per-volume manifest: a JSON record of what was built and how it verified.

The schema is `manifest.schema.json` in this package (JSON Schema 2020-12, `manifest_schema()`
loads it). `schema_version` is 1; a change that removes or redefines a field bumps it, and
`read_manifest` refuses any version it doesn't know. `build_manifest` makes one from a
`VerifyReport` (plus the `BuildResult` when the caller built the PDF); `error_manifest`
records a volume that couldn't be built or verified. `manifest_succeeded` is the test a
resumable batch uses to skip a volume.
"""

from __future__ import annotations

import json
import os
import platform
from collections.abc import Mapping
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path
from typing import Any

import lxml.etree
import pikepdf
import PIL

from stare_archival import __version__
from stare_archival.build import BuildResult
from stare_archival.errors import ManifestError
from stare_archival.verify import VerifyReport

MANIFEST_SCHEMA_VERSION = 1


def manifest_schema() -> dict[str, Any]:
    """The manifest's JSON Schema."""
    return json.loads(files("stare_archival").joinpath("manifest.schema.json").read_text())


def _generated(when: datetime | None) -> str:
    when = when or datetime.now(UTC)
    if when.tzinfo is None:
        raise ValueError("generated must be timezone-aware")
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tools(extra: dict[str, str] | None = None) -> dict[str, str]:
    tools = {
        "stare-archival": __version__,
        "python": platform.python_version(),
        "pikepdf": pikepdf.__version__,
        "qpdf": pikepdf.__libqpdf_version__,
        "pillow": PIL.__version__,
        "lxml": lxml.etree.__version__,
    }
    tools.update(extra or {})
    return tools


def package_versions() -> dict[str, str]:
    """This package's version and those of the Python libraries it builds with."""
    return _tools()


def _pins(
    jbig2_image: str | None = None,
    tools: Mapping[str, str] | None = None,
    pipeline_image: str | None = None,
) -> dict:
    """The container images this volume's build and verification ran, by digest: none for a
    G4 build or a jbig2 on PATH, verified without veraPDF, outside the pipeline image."""
    pins = {}
    if jbig2_image:
        pins["jbig2"] = jbig2_image
    if tools and tools.get("verapdf_image"):
        pins["verapdf"] = tools["verapdf_image"]
    if pipeline_image:
        pins["pipeline"] = pipeline_image
    return pins


def build_manifest(
    report: VerifyReport,
    build: BuildResult | None = None,
    *,
    jbig2_image: str | None = None,
    pipeline_image: str | None = None,
    generated: datetime | None = None,
) -> dict[str, Any]:
    """The manifest for a verified volume. `jbig2_image` is the container image the build ran
    jbig2 from, if it did (`Jbig2Encoder.docker_image`); `pipeline_image` the pipeline image
    the batch ran in. `generated` (default now) must be timezone-aware."""
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "volume_id": report.volume_id,
        "barcode": report.barcode,
        "status": "pass" if report.ok else "fail",
        "generated": _generated(generated),
        "source": {
            "tar": report.tar_path.name,
            "sha256": report.source_sha256,
            "recorded_sha256": report.recorded_source_sha256,
            "embedded_sha256": report.embedded_source_sha256,
        },
        "output": {
            "file": report.pdf_path.name,
            "sha256": report.output_sha256,
            "size": report.output_size,
            "page_count": report.page_count,
        },
        "encoder": {"name": report.encoder, "settings": report.encoder_settings},
        "build": None
        if build is None
        else {
            "bookmark_count": build.bookmark_count,
            "pages_without_text": build.pages_without_text,
            "image_bytes": build.image_bytes,
            "attachments": list(build.attachments),
        },
        "checks": [c.to_dict() for c in report.checks],
        "tools": _tools(dict(report.tools)),
        "pins": _pins(jbig2_image, report.tools, pipeline_image),
        "error": None,
    }


def error_manifest(
    volume_id: str | None,
    error: BaseException | str,
    *,
    source_sha256: str | None = None,
    tar: str | None = None,
    pipeline_image: str | None = None,
    generated: datetime | None = None,
) -> dict[str, Any]:
    """The manifest for a volume that couldn't be built or verified."""
    message = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "volume_id": volume_id,
        "barcode": None,
        "status": "error",
        "generated": _generated(generated),
        "source": {
            "tar": tar,
            "sha256": source_sha256,
            "recorded_sha256": None,
            "embedded_sha256": None,
        },
        "output": None,
        "encoder": None,
        "build": None,
        "checks": [],
        "tools": _tools(),
        "pins": _pins(pipeline_image=pipeline_image),
        "error": message,
    }


def manifest_succeeded(manifest: dict[str, Any], source_sha256: str) -> bool:
    """True when the manifest records a passing build of the tar with this SHA-256."""
    return (
        manifest.get("schema_version") == MANIFEST_SCHEMA_VERSION
        and manifest.get("status") == "pass"
        and (manifest.get("source") or {}).get("sha256") == source_sha256
    )


def write_manifest(path: str | os.PathLike[str], manifest: dict[str, Any]) -> None:
    """Write the manifest as indented JSON, beside `path` first and then renamed into place."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def read_manifest(path: str | os.PathLike[str]) -> dict[str, Any]:
    """A manifest written by `write_manifest`; ManifestError when it can't be read or has a
    schema version this code doesn't know."""
    path = Path(path)
    try:
        manifest = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"{path}: not a readable manifest ({exc})") from exc
    version = manifest.get("schema_version") if isinstance(manifest, dict) else None
    if version != MANIFEST_SCHEMA_VERSION:
        raise ManifestError(
            f"{path}: schema_version {version}, this code reads {MANIFEST_SCHEMA_VERSION}"
        )
    return manifest
