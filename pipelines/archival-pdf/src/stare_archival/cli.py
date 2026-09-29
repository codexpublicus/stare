"""The `stare-archival` command.

`stare-archival verify <pdf> --tar <tar>` verifies a built PDF against its tar and prints
one line per failure, then PASS or FAIL. It exits 0 when every check passes, 1 when a check
fails, and 2 when the PDF can't be verified at all (unreadable PDF or tar, missing tool).
`--manifest <path>` writes the volume manifest; `--json` prints it instead of the summary.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import TextIO

from stare_archival import __version__
from stare_archival.errors import ArchivalError
from stare_archival.external import VeraPdf
from stare_archival.manifest import build_manifest, write_manifest
from stare_archival.verify import DEFAULT_TOLERANCE_PT, verify_volume

EXIT_PASS, EXIT_FAIL, EXIT_ERROR = 0, 1, 2


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
        "--generated",
        type=datetime.fromisoformat,
        help="the manifest's generated time (ISO 8601 with a zone; default now)",
    )
    verify.add_argument("--json", action="store_true", help="print the manifest, not a summary")
    return parser


def _verify(args: argparse.Namespace, stdout: TextIO) -> int:
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
    manifest = build_manifest(report, generated=args.generated)
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
    except (ArchivalError, ValueError) as exc:
        stderr.write(f"stare-archival {args.command}: {exc}\n")
        return EXIT_ERROR
    return EXIT_ERROR  # pragma: no cover (argparse requires a command)


if __name__ == "__main__":
    sys.exit(main())
