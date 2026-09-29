"""The `stare-archival` command.

`stare-archival verify <pdf> --tar <tar>` verifies a built PDF against its tar and prints
one line per failure, then PASS or FAIL. It exits 0 when every check passes, 1 when a check
fails, and 2 when the PDF can't be verified at all (unreadable PDF or tar, missing tool).
`--manifest <path>` writes the volume manifest; `--json` prints it instead of the summary.

`stare-archival build <reporter>/<volume> --src <downloads> --out <dir>` builds, verifies
and (with `--upload`) uploads one volume; `stare-archival build-all` does every volume under
`--src` in parallel, resumably, and writes a run summary (see `stare_archival.runner`). Both
exit 0 when everything passed or was already done, 1 when a volume failed, 2 when they can't
run at all. The batch needs a native jbig2 (the pipeline image has one) or `--encoder g4`;
it refuses to run jbig2 in a container per page. `$STARE_ARCHIVAL_IMAGE`, when set, is
recorded in each manifest's pins as the pipeline image.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import TextIO

from stare_archival import __version__
from stare_archival.encoders import G4Encoder, ImageEncoder, Jbig2Encoder
from stare_archival.errors import ArchivalError
from stare_archival.external import Poppler, VeraPdf
from stare_archival.manifest import build_manifest, write_manifest
from stare_archival.runner import (
    Layout,
    VolumeJob,
    current_toolchain,
    find_volumes,
    format_summary,
    parse_size,
    plural,
    process_volume,
    progress_line,
    run_batch,
    run_id,
    summarize,
    write_run,
)
from stare_archival.upload import RcloneUploader
from stare_archival.verify import DEFAULT_TOLERANCE_PT, verify_volume

EXIT_PASS, EXIT_FAIL, EXIT_ERROR, EXIT_INTERRUPTED = 0, 1, 2, 130
DEFAULT_TIMEOUT_S = 3600.0


def _size(text: str) -> int:
    try:
        return parse_size(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _add_build_options(p: argparse.ArgumentParser) -> None:
    p.add_argument("--src", required=True, help="the mirror's downloads directory")
    p.add_argument("--out", required=True, help="the output directory")
    p.add_argument(
        "--encoder",
        choices=("jbig2", "g4"),
        default="jbig2",
        help="page image encoder (default jbig2, which must be native: PATH or $STARE_JBIG2)",
    )
    p.add_argument(
        "--upload",
        metavar="REMOTE",
        help="stream each verified volume to this rclone remote (e.g. r2:codex-data), check "
        "it there and delete the local PDF",
    )
    p.add_argument("--rclone", default="rclone", help="the rclone binary (default: on PATH)")
    p.add_argument("--force", action="store_true", help="rebuild volumes that are done")
    p.add_argument(
        "--work",
        help="scratch directory for page files while a volume runs (default: <out>/work); "
        "put it on local disk when --out is a network share",
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="stare-archival", description="Build and verify archival per-volume CAP PDFs."
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)

    verify = commands.add_parser("verify", help="verify a built PDF against its volume tar")
    verify.add_argument("pdf", help="the archival PDF")
    verify.add_argument("--tar", required=True, help="the volume tar it was built from")
    verify.add_argument("--csv", help="the tar's .tar.csv index (default: <tar>.csv)")
    verify.add_argument(
        "--sha256", help="the tar's recorded SHA-256 file (default: <tar>.sha256 if present)"
    )
    verify.add_argument(
        "--verapdf", action="store_true", help="also validate PDF/A-3b with veraPDF"
    )
    verify.add_argument(
        "--tolerance",
        type=float,
        default=DEFAULT_TOLERANCE_PT,
        help="word position tolerance in points (default %(default)s)",
    )
    verify.add_argument("--manifest", help="write the volume manifest (JSON) here")
    verify.add_argument(
        "--generated", help="the manifest's generated time (ISO 8601 with a zone; default now)"
    )
    verify.add_argument("--json", action="store_true", help="print the manifest, not a summary")

    build = commands.add_parser("build", help="build, verify (and upload) one volume")
    build.add_argument("volume", help="<reporter>/<volume>, e.g. a2d/152")
    _add_build_options(build)

    build_all = commands.add_parser(
        "build-all", help="build, verify (and upload) every volume, resumably"
    )
    _add_build_options(build_all)
    build_all.add_argument(
        "--jobs",
        type=int,
        default=os.cpu_count() or 1,
        help="volumes at once, one process each (default: the CPU count, %(default)s)",
    )
    build_all.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="REPORTER[/VOLUME]",
        help="only this reporter or volume (repeatable)",
    )
    build_all.add_argument("--limit", type=int, help="only the first N selected volumes")
    build_all.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help="seconds before a volume is killed and recorded as timed out (default %(default)g)",
    )
    build_all.add_argument(
        "--max-local-bytes",
        type=_size,
        metavar="SIZE",
        help="start a volume only while local PDFs plus running volumes' tar sizes stay under "
        "SIZE (e.g. 300G)",
    )
    return parser


def _generated(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        when = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"--generated {value!r} is not an ISO 8601 time") from exc
    if when.tzinfo is None:
        raise ValueError(f"--generated {value!r} needs a timezone (e.g. Z)")
    return when


def _verify(args: argparse.Namespace, stdout: TextIO) -> int:
    generated = _generated(args.generated)  # before the (slow) verification
    verapdf = None
    if args.verapdf:
        verapdf = VeraPdf.locate()
        if verapdf is None:
            raise ArchivalError("--verapdf: veraPDF is not available (PATH, $STARE_VERAPDF)")
    report = verify_volume(
        args.pdf,
        args.tar,
        args.csv,
        sha256_path=args.sha256,
        verapdf=verapdf,
        tolerance=args.tolerance,
    )
    manifest = build_manifest(report, generated=generated)
    if args.manifest:
        write_manifest(args.manifest, manifest)
    if args.json:
        stdout.write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    else:
        for failure in report.failures:
            stdout.write(f"{failure}\n")
        what = f"{report.volume_id} ({report.page_count} pages)"
        if report.ok:
            stdout.write(f"PASS {what}\n")
        else:
            n = len(report.failures)
            stdout.write(f"FAIL {what}: {n} failure{'' if n == 1 else 's'}\n")
    return EXIT_PASS if report.ok else EXIT_FAIL


def _encoder(kind: str) -> tuple[str | ImageEncoder, ImageEncoder]:
    """(what a job carries, the encoder itself) for --encoder."""
    if kind == "g4":
        return "g4", G4Encoder()
    enc = Jbig2Encoder.locate(docker=False)
    if enc is not None and enc.docker_image is not None:
        raise ArchivalError(
            "the batch won't run jbig2 in a container per page (about 200 ms a page); run it "
            "in the pipeline image, which has jbig2 on PATH, or unset $STARE_JBIG2=docker"
        )
    if enc is None:
        raise ArchivalError(
            "no native jbig2 (PATH or $STARE_JBIG2): run in the pipeline image, or use --encoder g4"
        )
    enc.name  # noqa: B018 (runs jbig2 --version now, so a broken binary fails up front)
    return enc.binary, enc


def _jobs_setup(args: argparse.Namespace) -> dict:
    job_encoder, encoder = _encoder(args.encoder)
    poppler = Poppler.locate()
    if poppler is None:
        raise ArchivalError("verification needs poppler's pdfimages and pdftotext on PATH")
    uploader = None
    if args.upload:
        rclone = shutil.which(args.rclone)
        if rclone is None:
            raise ArchivalError(f"--upload: {args.rclone} is not on PATH")
        uploader = RcloneUploader(args.upload, rclone=rclone)
    return {
        "src": Path(args.src),
        "out": Path(args.out),
        "toolchain": current_toolchain(encoder, poppler),
        "encoder": job_encoder,
        "uploader": uploader,
        "pipeline_image": os.environ.get("STARE_ARCHIVAL_IMAGE") or None,
        "force": args.force,
        "work": Path(args.work) if args.work else None,
    }


def _build(args: argparse.Namespace, stdout: TextIO) -> int:
    (ref,) = find_volumes(args.src, only=[args.volume])
    setup = _jobs_setup(args)
    result = process_volume(VolumeJob(ref=ref, **setup))
    stdout.write(progress_line(result, 1, 1).split("] ", 1)[1] + "\n")
    if result.status in ("pass", "uploaded", "skipped"):
        return EXIT_PASS
    return EXIT_ERROR if result.status == "error" else EXIT_FAIL


def _build_all(args: argparse.Namespace, stdout: TextIO) -> int:
    if args.jobs < 1:
        raise ArchivalError("--jobs must be at least 1")
    refs = find_volumes(args.src, only=args.only, limit=args.limit)
    setup = _jobs_setup(args)
    jobs = [VolumeJob(ref=ref, **setup) for ref in refs]
    layout = Layout(setup["out"], setup["work"])
    layout.runs.mkdir(parents=True, exist_ok=True)
    rid = run_id()
    log_path = layout.runs / f"{rid}.jsonl"
    workers = min(args.jobs, max(1, len(jobs)))
    settings = {
        "src": str(setup["src"]),
        "out": str(setup["out"]),
        "jobs": args.jobs,
        "timeout_s": args.timeout,
        "encoder": setup["toolchain"]["encoder"],
        "upload": args.upload,
        "max_local_bytes": args.max_local_bytes,
        "only": args.only,
        "limit": args.limit,
        "force": args.force,
        "work": args.work,
        "pipeline_image": setup["pipeline_image"],
        "toolchain": setup["toolchain"],
    }
    stdout.write(
        f"run {rid}: {plural(len(jobs), 'volume')}, {plural(workers, 'worker')}, "
        f"encoder {settings['encoder']}"
        + (f", uploading to {args.upload}" if args.upload else "")
        + "\n"
    )
    stdout.flush()
    with log_path.open("a") as log_file:

        def record(result) -> None:
            log_file.write(json.dumps(result.to_dict()) + "\n")
            log_file.flush()

        def log(line: str) -> None:
            stdout.write(line + "\n")
            stdout.flush()

        outcome = run_batch(
            jobs,
            workers=workers,
            timeout=args.timeout,
            max_local_bytes=args.max_local_bytes,
            log=log,
            record=record,
        )
    summary = summarize(outcome, run_id=rid, workers=workers, settings=settings)
    json_path, _ = write_run(layout, summary)
    stdout.write(format_summary(summary))
    stdout.write(f"  summary: {json_path}\n")
    if outcome.stopped == "interrupted":
        return EXIT_INTERRUPTED
    return EXIT_PASS if summary["ok"] else EXIT_FAIL


def main(
    argv: list[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    args = _parser().parse_args(argv)
    try:
        if args.command == "verify":
            return _verify(args, stdout)
        if args.command == "build":
            return _build(args, stdout)
        if args.command == "build-all":
            return _build_all(args, stdout)
    except (ArchivalError, ValueError) as exc:
        stderr.write(f"stare-archival {args.command}: {exc}\n")
        return EXIT_ERROR
    return EXIT_ERROR  # pragma: no cover (argparse requires a command)


if __name__ == "__main__":
    sys.exit(main())
