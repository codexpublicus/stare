"""The batch runner: build, verify and (optionally) upload every volume of a mirror.

The source is the mirror's `downloads/` directory, `<reporter>/<volume>.tar` with its
`.tar.csv` and, usually, `.tar.sha256`. Everything the runner writes goes under one output
directory:

    cap-pdf/<reporter>/<volume>.pdf              a verified PDF (the upload tree)
    cap-pdf/_manifests/<reporter>/<volume>.json  its passing manifest
    .staging/<reporter>/<volume>.pdf             a PDF being built and verified
    failed/<reporter>/<volume>.json              the manifest of a failed or broken volume
    failed/<reporter>/<volume>.pdf               a PDF that failed verification, for study
    uploaded/<reporter>/<volume>.json            receipt: uploaded and checked remotely
    work/<reporter>@<volume>/                    scratch space while a volume runs
    runs/<run id>.{json,txt,jsonl}               run summaries and per-volume records

A volume is built and verified in `.staging/` (on the output's filesystem) and renamed into
`cap-pdf/` only once it passes, so `cap-pdf/` never holds an unverified PDF or a temp file,
even after a crash, and can be copied as it is.

A volume is done, and skipped on the next run, when its passing manifest records the source
tar's current SHA-256 (from `.tar.sha256`, else computed) and the same toolchain (this
package, its libraries, poppler and the image encoder), and the PDF is either on disk with
the manifest's SHA-256 or recorded as uploaded with it. A volume that failed, errored or
timed out is tried again on the next run.

Streaming mode (an `Uploader`) uploads each passing volume's PDF and manifest as soon as it
verifies, checks the remote size and MD5, writes the receipt and deletes the local PDF; a
failed upload leaves the PDF for the next run to upload without rebuilding.

`run_batch` runs each volume in its own forked process (its own process group), at most
`workers` at a time, and kills the group of one that runs past `timeout`. With
`max_local_bytes` it counts the PDFs on local disk (walked once, then changed by what each
volume actually added or removed) plus, for each running volume that may build, its tar's
size (an upper bound on its PDF), and starts such a volume only while that stays under the
limit. A volume whose passing manifest matches this run (toolchain and recorded tar
SHA-256) and only needs an upload reserves nothing and goes first, and one that's simply
done reserves nothing; those still start when the disk is over the limit, since they free
space or take none, so an upload outage can't leave the next run unable to start.
"""

from __future__ import annotations

import contextlib
import json
import multiprocessing
import os
import re
import shutil
import signal
import tempfile
import time
from collections import deque
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from multiprocessing.connection import wait
from pathlib import Path
from typing import Any

from stare_archival.build import build_volume
from stare_archival.encoders import G4Encoder, ImageEncoder, Jbig2Encoder
from stare_archival.errors import ArchivalError, ManifestError, RunnerError, UploadError
from stare_archival.external import Poppler
from stare_archival.manifest import (
    build_manifest,
    error_manifest,
    manifest_succeeded,
    package_versions,
    read_manifest,
    write_manifest,
)
from stare_archival.upload import Uploader, md5_file
from stare_archival.verify import read_sha256_file, sha256_file, verify_volume

STATUSES = ("pass", "uploaded", "skipped", "fail", "error", "timeout", "upload_failed")
LABELS = {
    "pass": "PASS",
    "uploaded": "UPLOADED",
    "skipped": "SKIPPED",
    "fail": "FAIL",
    "error": "ERROR",
    "timeout": "TIMEOUT",
    "upload_failed": "UPLOAD FAILED",
}
_PROBLEMS = ("fail", "error", "timeout", "upload_failed")

# the tool versions a finished volume must share with this run to be skipped; the revision
# (from the pipeline image) makes a new image of changed code rebuild everything
TOOLCHAIN_TOOLS = (
    "stare-archival",
    "stare-archival-revision",
    "python",
    "pikepdf",
    "qpdf",
    "pillow",
    "lxml",
    "pdfimages",
    "pdftotext",
)

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$", re.IGNORECASE)
_MAX_ERROR = 2000


def natural_key(name: str) -> tuple:
    """Sort key putting "2" before "10" and "a2d" before "a3d"."""
    return tuple(
        (0, int(part), "") if part.isdigit() else (1, 0, part)
        for part in re.split(r"(\d+)", name)
        if part
    )


def parse_size(text: str) -> int:
    """A byte count: "123", "20M", "400G", "1.5T" (binary units; K, M, G, T, any case)."""
    m = _SIZE.match(text)
    if not m:
        raise ValueError(f"{text!r} is not a size (e.g. 400G)")
    power = " KMGT".index(m.group(2).upper() or " ")
    return int(float(m.group(1)) * 1024**power)


def plural(n: int, noun: str) -> str:
    return f"{n:,} {noun}" + ("" if n == 1 else "s")


def format_bytes(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(n) < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.2f} TiB"


@dataclass(frozen=True, order=True)
class VolumeRef:
    """A volume in the mirror's layout, `<reporter>/<volume>`."""

    reporter: str
    volume: str

    @property
    def id(self) -> str:
        return f"{self.reporter}/{self.volume}"

    @classmethod
    def parse(cls, text: str) -> VolumeRef:
        parts = text.split("/")
        if len(parts) != 2 or not all(_NAME.match(p) for p in parts):
            raise ValueError(f"{text!r} is not <reporter>/<volume>")
        return cls(*parts)


def _sort_key(ref: VolumeRef) -> tuple:
    return natural_key(ref.reporter), natural_key(ref.volume)


def find_volumes(
    src: str | os.PathLike[str], only: Iterable[str] = (), limit: int | None = None
) -> list[VolumeRef]:
    """The volumes under `src` (every `<reporter>/<volume>.tar`), in natural order, leaving
    out any tar aria2 is still downloading (it has a `.tar.aria2` control file beside it).

    `only` keeps the listed reporters (`us`) and volumes (`a2d/152`); an entry that isn't in
    `src` is a RunnerError. `limit` keeps the first N of what's left."""
    src = Path(src)
    if not src.is_dir():
        raise RunnerError(f"{src}: no such directory")
    refs, downloading = [], set()
    for reporter in src.iterdir():
        if not (_NAME.match(reporter.name) and reporter.is_dir()):
            continue
        names = {p.name for p in reporter.iterdir()}
        for name in names:
            stem = name.removesuffix(".tar")
            if name.endswith(".tar") and _NAME.match(stem):
                ref = VolumeRef(reporter.name, stem)
                if f"{name}.aria2" in names:
                    downloading.add(ref.id)
                else:
                    refs.append(ref)
    refs.sort(key=_sort_key)
    only = list(only)
    if only:
        reporters = {r.reporter for r in refs}
        ids = {r.id for r in refs}
        want_reporters, want_ids, missing = set(), set(), []
        for item in only:
            if "/" in item:
                try:
                    ref = VolumeRef.parse(item)
                except ValueError as exc:
                    raise RunnerError(str(exc)) from exc
                if ref.id in ids:
                    want_ids.add(ref.id)
                else:
                    missing.append(f"{item} (still downloading)" if item in downloading else item)
            else:
                (want_reporters.add(item) if item in reporters else missing.append(item))
        if missing:
            raise RunnerError(f"not in {src}: {', '.join(missing)}")
        refs = [r for r in refs if r.reporter in want_reporters or r.id in want_ids]
    return refs if limit is None else refs[:limit]


class Layout:
    """Where the runner keeps each volume's files under the output directory. Scratch space
    goes under `work` (default `<out>/work`), which can be on another disk."""

    PDF_ROOT = "cap-pdf"

    def __init__(
        self, out: str | os.PathLike[str], work: str | os.PathLike[str] | None = None
    ) -> None:
        self.out = Path(out)
        self.root = self.out / self.PDF_ROOT
        self.runs = self.out / "runs"
        self.work_root = Path(work) if work is not None else self.out / "work"

    def pdf_key(self, ref: VolumeRef) -> str:
        return f"{self.PDF_ROOT}/{ref.reporter}/{ref.volume}.pdf"

    def manifest_key(self, ref: VolumeRef) -> str:
        return f"{self.PDF_ROOT}/_manifests/{ref.reporter}/{ref.volume}.json"

    def pdf(self, ref: VolumeRef) -> Path:
        return self.out / self.pdf_key(ref)

    def manifest(self, ref: VolumeRef) -> Path:
        return self.out / self.manifest_key(ref)

    def failed_manifest(self, ref: VolumeRef) -> Path:
        return self.out / "failed" / ref.reporter / f"{ref.volume}.json"

    def failed_pdf(self, ref: VolumeRef) -> Path:
        return self.out / "failed" / ref.reporter / f"{ref.volume}.pdf"

    def receipt(self, ref: VolumeRef) -> Path:
        return self.out / "uploaded" / ref.reporter / f"{ref.volume}.json"

    def staging(self, ref: VolumeRef) -> Path:
        return self.out / ".staging" / ref.reporter / f"{ref.volume}.pdf"

    def volume_bytes(self, ref: VolumeRef) -> int:
        """Bytes of this volume's PDFs on local disk: finished, failed, staged or half written."""
        paths = (self.pdf(ref), self.failed_pdf(ref), self.staging(ref))
        return sum(_size(p) + _size(p.with_name(p.name + ".tmp")) for p in paths)

    def work(self, ref: VolumeRef) -> Path:
        return self.work_root / f"{ref.reporter}@{ref.volume}"

    def local_bytes(self) -> int:
        """Bytes of PDFs (finished, failed or half-written) and scratch files on disk."""
        total = 0
        for base, pattern in (
            (self.root, "*.pdf"),
            (self.root, "*.tmp"),
            (self.out / "failed", "*.pdf"),
            (self.out / ".staging", "*"),
            (self.work_root, "*"),
        ):
            if base.is_dir():
                total += sum(p.stat().st_size for p in base.rglob(pattern) if p.is_file())
        return total


def current_toolchain(encoder: ImageEncoder, poppler: Poppler) -> dict[str, str]:
    """This run's toolchain, as `toolchain_matches` compares it with a manifest's."""
    versions = package_versions()
    toolchain = {k: versions[k] for k in TOOLCHAIN_TOOLS if k in versions}
    toolchain.update(poppler.tool_versions())
    toolchain["encoder"] = encoder.name
    toolchain["encoder_settings"] = encoder.settings
    return toolchain


def manifest_toolchain(manifest: Mapping[str, Any]) -> dict[str, str | None]:
    tools = manifest.get("tools") or {}
    toolchain = {k: tools.get(k) for k in TOOLCHAIN_TOOLS}
    encoder = manifest.get("encoder") or {}
    toolchain["encoder"] = encoder.get("name")
    toolchain["encoder_settings"] = encoder.get("settings")
    return toolchain


def toolchain_matches(manifest: Mapping[str, Any], toolchain: Mapping[str, str]) -> bool:
    return manifest_toolchain(manifest) == {
        k: toolchain.get(k) for k in (*TOOLCHAIN_TOOLS, "encoder", "encoder_settings")
    }


@dataclass(frozen=True)
class VolumeJob:
    """One volume for `process_volume`. `encoder` is "g4", a path to (or the name of) a
    native jbig2 binary, or an `ImageEncoder`. `created` fixes the PDF's dates and the
    manifest's time (tests); `force` rebuilds a finished volume. `work` is the scratch
    directory (default `<out>/work`)."""

    ref: VolumeRef
    src: Path
    out: Path
    toolchain: Mapping[str, str]
    encoder: str | ImageEncoder = "jbig2"
    uploader: Uploader | None = None
    pipeline_image: str | None = None
    created: datetime | None = None
    force: bool = False
    work: Path | None = None

    @property
    def tar(self) -> Path:
        return Path(self.src) / self.ref.reporter / f"{self.ref.volume}.tar"

    @property
    def sha256_path(self) -> Path:
        return self.tar.with_name(self.tar.name + ".sha256")

    def reserve_bytes(self) -> int:
        try:
            return self.tar.stat().st_size
        except OSError:
            return 0


@dataclass(frozen=True)
class VolumeResult:
    """What happened to one volume. Times are in seconds; `local_bytes` is what the volume
    left on local disk (a PDF not yet uploaded, or one that failed); `failed_checks` counts
    each failing check's failures and `warned_checks` each advisory check's warnings."""

    volume_id: str
    status: str
    pages: int = 0
    build_s: float = 0.0
    verify_s: float = 0.0
    upload_s: float = 0.0
    output_size: int = 0
    local_bytes: int = 0
    failed_checks: Mapping[str, int] = field(default_factory=dict)
    error: str | None = None
    warned_checks: Mapping[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["failed_checks"] = dict(self.failed_checks)
        d["warned_checks"] = dict(self.warned_checks)
        return d


def _encoder(spec: str | ImageEncoder) -> ImageEncoder:
    if not isinstance(spec, str):
        return spec
    return G4Encoder() if spec == "g4" else Jbig2Encoder(spec)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def _passing_manifest(path: Path) -> dict[str, Any] | None:
    try:
        manifest = read_manifest(path)
    except ManifestError:
        return None
    return manifest if manifest.get("status") == "pass" else None


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _message(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:_MAX_ERROR]


def record_error(job: VolumeJob, message: str) -> None:
    """Write an error manifest for a volume that couldn't be built or verified, and remove
    what it left half done (a PDF without a passing manifest, scratch files)."""
    lay = Layout(job.out, job.work)
    ref = job.ref
    if _passing_manifest(lay.manifest(ref)) is None:
        lay.pdf(ref).unlink(missing_ok=True)
    for half_done in (lay.pdf(ref), lay.staging(ref)):
        half_done.with_name(half_done.name + ".tmp").unlink(missing_ok=True)
    lay.staging(ref).unlink(missing_ok=True)
    shutil.rmtree(lay.work(ref), ignore_errors=True)
    write_manifest(
        lay.failed_manifest(ref),
        error_manifest(
            ref.id,
            message,
            tar=job.tar.name,
            pipeline_image=job.pipeline_image,
            generated=job.created,
        ),
    )


def process_volume(job: VolumeJob) -> VolumeResult:
    """Build, verify and (with an uploader) upload one volume, unless it's already done.
    Never raises for a problem with the volume: that's a result with status "error"."""
    try:
        return _process(job, Layout(job.out, job.work))
    except Exception as exc:  # noqa: BLE001 (one volume's failure must not stop the batch)
        message = _message(exc)
        with contextlib.suppress(Exception):
            record_error(job, message)
        return VolumeResult(job.ref.id, "error", error=message)


def _done(job: VolumeJob, lay: Layout) -> VolumeResult | None:
    """The result for a volume that needs no build (skipped, or only an upload), or None."""
    ref = job.ref
    manifest = _passing_manifest(lay.manifest(ref))
    if manifest is None or not toolchain_matches(manifest, job.toolchain):
        return None
    recorded = read_sha256_file(job.sha256_path) if job.sha256_path.is_file() else None
    if not manifest_succeeded(manifest, recorded or sha256_file(job.tar)):
        return None
    output = manifest["output"]
    pdf = lay.pdf(ref)
    receipt = _read_json(lay.receipt(ref))
    if (
        receipt is not None
        and (receipt.get("pdf") or {}).get("sha256") == output["sha256"]
        and (receipt.get("manifest") or {}).get("md5") == md5_file(lay.manifest(ref))
    ):
        return VolumeResult(
            ref.id,
            "skipped",
            pages=output["page_count"],
            output_size=output["size"],
            local_bytes=_size(pdf),
        )
    if not (pdf.is_file() and sha256_file(pdf) == output["sha256"]):
        return None
    if job.uploader is None:
        return VolumeResult(
            ref.id,
            "skipped",
            pages=output["page_count"],
            output_size=output["size"],
            local_bytes=_size(pdf),
        )
    return _upload(job, lay, output["page_count"], output["sha256"], "uploaded")


def _process(job: VolumeJob, lay: Layout) -> VolumeResult:
    ref = job.ref
    if not job.force:
        done = _done(job, lay)
        if done is not None:
            return done
    pdf, staged = lay.pdf(ref), lay.staging(ref)
    for stale in (
        lay.manifest(ref),
        lay.receipt(ref),
        pdf,
        lay.failed_manifest(ref),
        lay.failed_pdf(ref),
        staged,
        staged.with_name(staged.name + ".tmp"),
    ):
        stale.unlink(missing_ok=True)
    staged.parent.mkdir(parents=True, exist_ok=True)
    work = lay.work(ref)
    work.mkdir(parents=True, exist_ok=True)
    tempdir = tempfile.tempdir
    tempfile.tempdir = str(work)  # jbig2's page files and pdfimages' output go here
    try:
        source_sha256 = sha256_file(job.tar)
        started = time.monotonic()
        build = build_volume(
            job.tar,
            None,
            staged,
            _encoder(job.encoder),
            volume_id=ref.id,
            source_sha256=source_sha256,
            created=job.created,
        )
        build_s = time.monotonic() - started
        started = time.monotonic()
        report = verify_volume(staged, job.tar)
        verify_s = time.monotonic() - started
    finally:
        tempfile.tempdir = tempdir
        shutil.rmtree(work, ignore_errors=True)

    manifest = build_manifest(
        report, build, pipeline_image=job.pipeline_image, generated=job.created
    )
    common = {
        "warned_checks": {c.name: len(c.failures) for c in report.checks if c.status == "warn"},
        "pages": report.page_count,
        "build_s": build_s,
        "verify_s": verify_s,
        "output_size": report.output_size,
    }
    if not report.ok:
        failed_checks = {
            c.name: max(1, len(c.failures)) for c in report.checks if c.status == "fail"
        }
        write_manifest(lay.failed_manifest(ref), manifest)
        lay.failed_pdf(ref).parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, lay.failed_pdf(ref))
        return VolumeResult(
            ref.id,
            "fail",
            local_bytes=_size(lay.failed_pdf(ref)),
            failed_checks=failed_checks,
            **common,
        )
    pdf.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staged, pdf)  # verified: into the upload tree, then its manifest
    write_manifest(lay.manifest(ref), manifest)
    if job.uploader is None:
        return VolumeResult(ref.id, "pass", local_bytes=_size(pdf), **common)
    uploaded = _upload(job, lay, report.page_count, report.output_sha256, "uploaded")
    return VolumeResult(
        ref.id,
        uploaded.status,
        upload_s=uploaded.upload_s,
        local_bytes=uploaded.local_bytes,
        error=uploaded.error,
        **common,
    )


def _upload(job: VolumeJob, lay: Layout, pages: int, sha256: str, status: str) -> VolumeResult:
    """Upload the PDF, then its manifest; write the receipt and delete the local PDF."""
    assert job.uploader is not None  # noqa: S101 (callers check)
    ref = job.ref
    pdf, manifest = lay.pdf(ref), lay.manifest(ref)
    size = _size(pdf)
    started = time.monotonic()
    try:
        pdf_obj = job.uploader.upload(pdf, lay.pdf_key(ref))
        manifest_obj = job.uploader.upload(manifest, lay.manifest_key(ref))
    except UploadError as exc:
        return VolumeResult(
            ref.id,
            "upload_failed",
            pages=pages,
            output_size=size,
            upload_s=time.monotonic() - started,
            local_bytes=size,
            error=_message(exc),
        )
    _write_json(
        lay.receipt(ref),
        {
            "volume_id": ref.id,
            "uploaded": _now(),
            "pdf": {
                "key": pdf_obj.key,
                "size": pdf_obj.size,
                "md5": pdf_obj.md5,
                "sha256": sha256,
            },
            "manifest": {
                "key": manifest_obj.key,
                "size": manifest_obj.size,
                "md5": manifest_obj.md5,
            },
        },
    )
    pdf.unlink()
    lay.failed_manifest(ref).unlink(missing_ok=True)  # e.g. from an upload that timed out
    return VolumeResult(
        ref.id,
        status,
        pages=pages,
        output_size=size,
        upload_s=time.monotonic() - started,
    )


# --- the batch ---------------------------------------------------------------------------


@dataclass
class BatchOutcome:
    """Every finished volume's result, in the order they finished. `stopped` says why the
    run ended before every selected volume ran (the disk guard, an interruption)."""

    results: list[VolumeResult]
    elapsed_s: float
    stopped: str | None
    selected: int


class _InterruptedError(Exception):
    pass


def _raise_interrupted(signum, frame):  # noqa: ARG001 (signal handler signature)
    raise _InterruptedError


@dataclass
class _Running:
    job: VolumeJob
    process: Any
    conn: Any
    deadline: float
    reserved: int
    bytes_before: int


def _kill(run: _Running) -> None:
    """SIGKILL the worker's whole process group (jbig2, pdfimages), then the worker."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(run.process.pid, signal.SIGKILL)
    run.process.kill()
    run.process.join()
    run.conn.close()


def _plan(job: VolumeJob, lay: Layout) -> tuple[str, int]:
    """What a job will most likely do, judged in the parent without hashing: ("upload", 0)
    when its passing manifest matches this run (toolchain and the recorded tar sha256) and
    the PDF waits locally with no receipt; ("skip", 0) when it matches and the PDF is on disk
    or uploaded; otherwise ("build", the tar's size). A tar without a `.tar.sha256` counts
    as a build here (checking it means hashing the tar); the worker decides properly."""
    ref = job.ref
    manifest = _passing_manifest(lay.manifest(ref))
    if manifest is not None and toolchain_matches(manifest, job.toolchain):
        try:
            recorded = read_sha256_file(job.sha256_path) if job.sha256_path.is_file() else None
        except (OSError, ValueError, ArchivalError):
            recorded = None
        if recorded is not None and manifest_succeeded(manifest, recorded):
            pdf, receipt = lay.pdf(ref).is_file(), lay.receipt(ref).is_file()
            if job.uploader is not None and pdf and not receipt:
                return "upload", 0
            if pdf or receipt:
                return "skip", 0
    return "build", job.reserve_bytes()


def _child(worker: Callable[[VolumeJob], VolumeResult], job: VolumeJob, conn) -> None:
    os.setpgrp()  # the parent kills the whole group on a timeout
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the parent stops us
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    try:
        result = worker(job)
    except BaseException as exc:  # noqa: BLE001 (reported, not raised)
        result = VolumeResult(job.ref.id, "error", error=_message(exc))
    conn.send(result)
    conn.close()


def _abandon(job: VolumeJob, message: str) -> None:
    with contextlib.suppress(Exception):
        record_error(job, message)


def run_batch(
    jobs: Sequence[VolumeJob],
    *,
    workers: int,
    timeout: float,
    max_local_bytes: int | None = None,
    worker: Callable[[VolumeJob], VolumeResult] = process_volume,
    log: Callable[[str], None] | None = None,
    record: Callable[[VolumeResult], None] | None = None,
) -> BatchOutcome:
    """Run `worker` (default `process_volume`) on every job, each in a forked process, at
    most `workers` at a time, killing any that runs longer than `timeout` seconds. Any
    failure in this loop stops the run: the running volumes are killed and recorded, and
    `stopped` says why ("interrupted", "crashed: ...", "disk guard: ...")."""
    ctx = multiprocessing.get_context("fork")
    guard = max_local_bytes is not None
    layouts = {id(j): Layout(j.out, j.work) for j in jobs}
    plans = {}
    if guard or any(j.uploader is not None for j in jobs):
        plans = {id(j): _plan(j, layouts[id(j)]) for j in jobs}
    ordered = sorted(jobs, key=lambda j: plans.get(id(j), ("",))[0] != "upload")  # stable
    pending = deque(ordered)
    running: list[_Running] = []
    results: list[VolumeResult] = []
    stopped: str | None = None
    local = 0
    if guard:
        dirs = {(Path(j.out), j.work) for j in jobs}
        local = sum(Layout(out, work).local_bytes() for out, work in dirs)
    reserved = 0
    started = time.monotonic()
    total = len(jobs)

    def finished(run: _Running, result: VolumeResult) -> None:
        nonlocal local, reserved
        running.remove(run)
        reserved -= run.reserved
        if guard:  # what the volume actually added to or removed from local disk
            local += layouts[id(run.job)].volume_bytes(run.job.ref) - run.bytes_before
        results.append(result)
        if record:
            record(result)
        if log:
            log(progress_line(result, len(results), total))

    previous = signal.signal(signal.SIGTERM, _raise_interrupted)
    try:
        while pending or running:
            while pending and stopped is None and len(running) < workers:
                job = pending[0]
                lay = layouts[id(job)]
                kind, need = plans.get(id(job), ("build", 0))
                # uploads free space and skips take none; only a build is held back
                if guard and kind == "build" and local + reserved + need > max_local_bytes:
                    if not running:
                        stopped = (
                            f"disk guard: {format_bytes(local)} on local disk, and "
                            f"{job.ref.id} may need {format_bytes(need)} more, over "
                            f"--max-local-bytes {format_bytes(max_local_bytes)}"
                        )
                    break
                pending.popleft()
                before = lay.volume_bytes(job.ref) if guard else 0  # before the fork
                receiver, sender = ctx.Pipe(duplex=False)
                process = ctx.Process(
                    target=_child, args=(worker, job, sender), name=f"volume {job.ref.id}"
                )
                process.start()
                sender.close()
                running.append(
                    _Running(job, process, receiver, time.monotonic() + timeout, need, before)
                )
                reserved += need
            if not running:
                break
            next_deadline = min(r.deadline for r in running)
            ready = wait(
                [r.process.sentinel for r in running],
                timeout=max(0.0, next_deadline - time.monotonic()),
            )
            now = time.monotonic()
            for run in list(running):
                if run.process.sentinel in ready:
                    finished(run, _collect(run))
                elif now >= run.deadline:
                    _kill(run)
                    message = f"timed out after {timeout:g} s"
                    _abandon(run.job, message)
                    finished(run, VolumeResult(run.job.ref.id, "timeout", error=message))
    except BaseException as exc:  # noqa: BLE001 (stop the pool cleanly, then report)
        if isinstance(exc, KeyboardInterrupt | _InterruptedError):
            stopped = "interrupted"
        else:
            stopped = f"crashed: {_message(exc)}"
        for run in list(running):
            _kill(run)
            _abandon(run.job, f"{stopped}; not finished")
    finally:
        signal.signal(signal.SIGTERM, previous)
    return BatchOutcome(results, time.monotonic() - started, stopped, total)


def _collect(run: _Running) -> VolumeResult:
    result = None
    with contextlib.suppress(EOFError, OSError):
        if run.conn.poll():
            result = run.conn.recv()
    run.process.join()
    run.conn.close()
    if result is None:
        message = f"the worker exited with code {run.process.exitcode} before reporting"
        _abandon(run.job, message)
        result = VolumeResult(run.job.ref.id, "error", error=message)
    return result


def progress_line(result: VolumeResult, done: int, total: int) -> str:
    line = f"[{done}/{total}] {LABELS.get(result.status, result.status)} {result.volume_id}"
    if result.pages:
        line += f" {result.pages} pages"
    if result.build_s:
        line += f", build {result.build_s:.1f} s, verify {result.verify_s:.1f} s"
    if result.upload_s:
        line += f", upload {result.upload_s:.1f} s"
    if result.failed_checks:
        line += ": " + _checks(result.failed_checks)
    if result.warned_checks:
        line += " (warnings: " + _checks(result.warned_checks) + ")"
    if result.error:
        line += f": {result.error}"
    return line


def _checks(failed: Mapping[str, int]) -> str:
    return ", ".join(f"{name} ({n})" for name, n in failed.items())


# --- the summary -------------------------------------------------------------------------


def summarize(
    outcome: BatchOutcome, *, run_id: str, workers: int, settings: Mapping[str, Any]
) -> dict[str, Any]:
    """The run summary: counts by status, which checks failed on how many volumes,
    throughput, every problem, and every volume's result."""
    results = outcome.results
    counts = {"selected": outcome.selected, **dict.fromkeys(STATUSES, 0)}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    counts["not_run"] = outcome.selected - len(results)
    by_check: dict[str, int] = {}
    for r in results:
        for name in r.failed_checks:
            by_check[name] = by_check.get(name, 0) + 1
    warned: dict[str, int] = {}
    for r in results:
        for name in r.warned_checks:
            warned[name] = warned.get(name, 0) + 1
    built = [r for r in results if r.build_s > 0]
    pages_built = sum(r.pages for r in built)
    build_s = sum(r.build_s for r in built)
    verify_s = sum(r.verify_s for r in built)
    upload_s = sum(r.upload_s for r in results)
    worker_s = build_s + verify_s + sum(r.upload_s for r in built)
    elapsed = outcome.elapsed_s

    def ratio(a: float, b: float) -> float:
        return round(a / b, 3) if b else 0.0

    return {
        "run_id": run_id,
        "finished": _now(),
        "elapsed_s": round(elapsed, 3),
        "workers": workers,
        "settings": dict(settings),
        "stopped": outcome.stopped,
        "ok": outcome.stopped is None and all(counts[s] == 0 for s in (*_PROBLEMS, "not_run")),
        "counts": counts,
        "pages": {
            "built": pages_built,
            "skipped": sum(r.pages for r in results if r.status == "skipped"),
        },
        "bytes_built": sum(r.output_size for r in built),
        "throughput": {
            "volumes_built": len(built),
            "pages_per_second": ratio(pages_built, elapsed),
            "pages_per_worker_second": ratio(pages_built, worker_s),
            "build_ms_per_page": ratio(1000 * build_s, pages_built),
            "verify_ms_per_page": ratio(1000 * verify_s, pages_built),
            "upload_s": round(upload_s, 3),
        },
        "failures_by_check": dict(sorted(by_check.items())),
        "warnings_by_check": dict(sorted(warned.items())),
        "problems": [r.to_dict() for r in results if r.status in _PROBLEMS],
        "volumes": [r.to_dict() for r in results],
    }


_MAX_PROBLEM_LINES = 50


def format_summary(summary: Mapping[str, Any]) -> str:
    """The run summary for a person to read."""
    c = summary["counts"]
    t = summary["throughput"]
    minutes = summary["elapsed_s"] / 60
    lines = [
        f"stare-archival build-all, run {summary['run_id']}: "
        + ("OK" if summary["ok"] else "INCOMPLETE"),
        f"  selected {c['selected']}: pass {c['pass']}, uploaded {c['uploaded']}, "
        f"skipped {c['skipped']}, fail {c['fail']}, error {c['error']}, "
        f"timeout {c['timeout']}, upload failed {c['upload_failed']}, not run {c['not_run']}",
        f"  built {plural(t['volumes_built'], 'volume')}, {summary['pages']['built']:,} pages, "
        f"{format_bytes(summary['bytes_built'])} in {minutes:.1f} min with "
        f"{plural(summary['workers'], 'worker')}: {t['pages_per_second']:.1f} pages/s, "
        f"{t['pages_per_worker_second']:.1f} pages/s per worker "
        f"(build {t['build_ms_per_page']:.1f} ms/page, verify {t['verify_ms_per_page']:.1f} "
        f"ms/page, upload {t['upload_s']:.0f} s in all)",
    ]
    if summary["failures_by_check"]:
        lines.append(
            "  failing checks (volumes): "
            + ", ".join(f"{k} {v}" for k, v in summary["failures_by_check"].items())
        )
    if summary["warnings_by_check"]:
        lines.append(
            "  warnings (volumes): "
            + ", ".join(f"{k} {v}" for k, v in summary["warnings_by_check"].items())
        )
    if summary["stopped"]:
        lines.append(f"  stopped: {summary['stopped']}")
    problems = summary["problems"]
    for p in problems[:_MAX_PROBLEM_LINES]:
        line = f"  {LABELS.get(p['status'], p['status'])} {p['volume_id']}"
        if p["failed_checks"]:
            line += ": " + _checks(p["failed_checks"])
        elif p["error"]:
            line += f": {p['error']}"
        lines.append(line)
    if len(problems) > _MAX_PROBLEM_LINES:
        lines.append(f"  ... and {len(problems) - _MAX_PROBLEM_LINES} more in the JSON summary")
    return "\n".join(lines) + "\n"


def write_run(layout: Layout, summary: Mapping[str, Any]) -> tuple[Path, Path]:
    """Write the summary as `runs/<run id>.json` and `.txt`; returns both paths."""
    layout.runs.mkdir(parents=True, exist_ok=True)
    json_path = layout.runs / f"{summary['run_id']}.json"
    text_path = layout.runs / f"{summary['run_id']}.txt"
    _write_json(json_path, summary)
    text_path.write_text(format_summary(summary))
    return json_path, text_path


def run_id(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
