"""The ``stare-cl`` command.

``stare-cl dates`` lists the complete exports in the bucket, newest first. ``stare-cl fetch``
downloads one export's tables into ``<dest>/<date>/`` (resuming any partial file) and
writes ``export.json``; ``stare-cl verify`` re-hashes the files against it; ``stare-cl head``
prints a table's first rows as JSON. ``stare-cl stage``, ``text`` and ``records`` turn a
fetched export into per-case records. ``--dest`` defaults to ``$STARE_CL_DIR``.

Exit status: 0 on success, 1 when ``verify`` finds a mismatch, 2 when the command can't
run (bad arguments, a missing table, a refused request).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import TextIO

import httpx

from stare_courtlistener import __version__
from stare_courtlistener.fetch import export_dir, fetch_export, verify_export
from stare_courtlistener.listing import (
    DEFAULT_TABLES,
    KNOWN_TABLES,
    MIN_TABLE_BYTES,
    OPTIONAL_TABLES,
    Entry,
    complete_exports,
    list_entries,
    min_bytes_for,
    table_file,
)
from stare_courtlistener.table import open_table, read_table

# The record-building steps import lazily: ``fetch`` and friends don't need them.

EXIT_OK, EXIT_FAIL, EXIT_ERROR = 0, 1, 2
DEST_ENV = "STARE_CL_DIR"
DEFAULT_WIDTH = 200


class UsageError(Exception):
    """A problem with the arguments, reported in one line."""


def human(n: float) -> str:
    """A byte count in decimal units, e.g. ``55.1 GB``."""
    for unit in ("B", "kB", "MB", "GB"):
        if abs(n) < 1000:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} TB"


def _date(text: str) -> date:
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"{text!r} isn't a YYYY-MM-DD date") from exc


def _date_or_latest(text: str) -> date | str:
    return text if text == "latest" else _date(text)


def _tables(values: Sequence[str] | None) -> list[str]:
    tables = list(values) if values else list(DEFAULT_TABLES)
    if unknown := [t for t in tables if t not in KNOWN_TABLES]:
        raise UsageError(
            f"unknown table {', '.join(unknown)}; known tables: {', '.join(KNOWN_TABLES)}"
        )
    return tables


def _dest(value: str | None) -> Path:
    dest = value or os.environ.get(DEST_ENV)
    if not dest:
        raise UsageError(f"no --dest, and ${DEST_ENV} isn't set")
    return Path(dest)


def _client() -> httpx.Client:
    return httpx.Client(
        transport=httpx.HTTPTransport(retries=3),
        timeout=httpx.Timeout(60.0),
        follow_redirects=False,
        headers={"User-Agent": f"stare-courtlistener/{__version__}"},
    )


class _Progress:
    """Prints a download's progress to stderr every ``every`` seconds, and at the end."""

    def __init__(self, out: TextIO, every: float = 10.0) -> None:
        self.out = out
        self.every = every
        self.name = ""
        self.start = 0.0
        self.first = 0
        self.last = 0.0

    def __call__(self, name: str, have: int, size: int) -> None:
        now = time.monotonic()
        if name != self.name:
            self.name, self.start, self.first, self.last = name, now, have, now
            return
        if have < size and now - self.last < self.every:
            return
        self.last = now
        rate = (have - self.first) / max(now - self.start, 1e-6)
        print(
            f"  {name}: {human(have)} / {human(size)} ({100 * have / size:.0f}%), {human(rate)}/s",
            file=self.out,
            flush=True,
        )


def cmd_dates(args: argparse.Namespace, out: TextIO) -> int:
    tables = _tables(args.tables)
    with _client() as http:
        entries = list_entries(http)
    by_date: dict[date, dict[str, Entry]] = {}
    for entry in entries:
        if entry.table in tables:
            by_date.setdefault(entry.date, {})[entry.table] = entry
    complete = complete_exports(entries, tables, min_bytes=args.min_bytes)
    shown = sorted(by_date, reverse=True) if args.all else complete
    for when in shown:
        found = by_date[when]
        total = sum(e.size for e in found.values())
        mark = "" if when in complete else "  (incomplete)"
        parts = []
        for table in tables:
            entry = found.get(table)
            if entry is None:
                parts.append(f"{table} missing")
            elif entry.size < min_bytes_for(table, args.min_bytes):
                parts.append(f"{table} placeholder ({entry.size} B)")
            else:
                parts.append(f"{table} {human(entry.size)}")
        print(f"{when.isoformat()}  {human(total):>9}  {', '.join(parts)}{mark}", file=out)
    if not shown:
        print(f"no complete export of {', '.join(tables)}", file=sys.stderr)
    return EXIT_OK


def cmd_fetch(args: argparse.Namespace, out: TextIO) -> int:
    tables = _tables(args.tables)
    dest = _dest(args.dest)
    with _client() as http:
        entries = list_entries(http)
        if args.date == "latest":
            complete = complete_exports(entries, tables, min_bytes=args.min_bytes)
            if not complete:
                raise UsageError(f"the bucket has no complete export of {', '.join(tables)}")
            when = complete[0]
        else:
            when = args.date
        wanted = [e for e in entries if e.date == when and e.table in tables]
        total = sum(e.size for e in wanted)
        print(
            f"Fetching the {when} export ({', '.join(tables)}; {human(total)}) into "
            f"{export_dir(dest, when)}",
            file=out,
            flush=True,
        )
        directory = fetch_export(
            when,
            dest,
            http,
            tables=tables,
            entries=entries,
            min_bytes=args.min_bytes,
            on_progress=_Progress(sys.stderr),
        )
    print(f"Fetched {when}: {directory / 'export.json'}", file=out)
    return EXIT_OK


def cmd_verify(args: argparse.Namespace, out: TextIO) -> int:
    directory = export_dir(_dest(args.dest), args.date)
    passed, failures = verify_export(directory)
    for table in passed:
        print(f"ok    {table}", file=out)
    for failure in failures:
        print(f"FAIL  {failure}", file=out)
    print("PASS" if not failures else "FAIL", file=out)
    return EXIT_OK if not failures else EXIT_FAIL


def _truncate(value: str | None, width: int) -> str | None:
    if value is None or width <= 0 or len(value) <= width:
        return value
    return f"{value[:width]}… ({len(value)} chars)"


def cmd_head(args: argparse.Namespace, out: TextIO) -> int:
    path = export_dir(_dest(args.dest), args.date) / table_file(args.table, args.date)
    if not path.exists():
        raise UsageError(f"{path} doesn't exist")
    with open_table(path) as fh:
        for n, row in enumerate(read_table(fh, args.table), start=1):
            if n > args.n:
                break
            shown = {k: _truncate(v, args.width) for k, v in row.items()}
            print(json.dumps(shown, ensure_ascii=False), file=out)
    return EXIT_OK


def cmd_stage(args: argparse.Namespace, out: TextIO) -> int:
    from stare_courtlistener.capindex import CapIndex, PageIndex
    from stare_courtlistener.stage import STAGE_REPORT, stage_export

    directory = export_dir(_dest(args.dest), args.date)
    index = CapIndex.load(Path(args.index_manifest))
    pages = None
    if args.index_dir:
        root = Path(args.index_dir)
        if not root.is_dir():
            raise UsageError(f"{root} isn't a directory")
        pages = PageIndex(root, index)
    result = stage_export(directory, args.date, index, page_index=pages)
    print(json.dumps(result["classes"]), file=out)
    print(f"Staged {args.date}: {directory / STAGE_REPORT}", file=out)
    return EXIT_OK


def cmd_text(args: argparse.Namespace, out: TextIO) -> int:
    from stare_courtlistener.spool import TEXT_DB, spool_text

    directory = export_dir(_dest(args.dest), args.date)
    result = spool_text(directory, args.date, restart=args.restart)
    print(json.dumps(result), file=out)
    print(f"Spooled {args.date}: {directory / TEXT_DB}", file=out)
    return EXIT_OK


def cmd_records(args: argparse.Namespace, out: TextIO) -> int:
    from stare_courtlistener.records import RECORDS_REPORT, build_records, export_out

    dest = _dest(args.dest)
    directory = export_dir(dest, args.date)
    target = Path(args.out) if args.out else dest / "out"
    previous = Path(args.previous) if args.previous else None
    if previous is not None and not previous.exists():
        raise UsageError(f"{previous} doesn't exist")
    result = build_records(directory, args.date, target, previous=previous, jobs=args.jobs)
    print(json.dumps({k: result[k] for k in ("records", "no_text", "gz_bytes", "delta")}), file=out)
    print(f"Records for {args.date}: {export_out(target, args.date)}", file=out)
    print(f"Report: {directory / RECORDS_REPORT}", file=out)
    return EXIT_OK


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="stare-cl", description=__doc__.split("\n\n")[1])
    p.add_argument("--version", action="version", version=f"stare-cl {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    def tables_option(sp: argparse.ArgumentParser) -> None:
        sp.add_argument(
            "--tables",
            nargs="+",
            metavar="TABLE",
            help=f"tables (default: {' '.join(DEFAULT_TABLES)}; also {' '.join(OPTIONAL_TABLES)})",
        )
        sp.add_argument(
            "--min-bytes",
            type=int,
            default=MIN_TABLE_BYTES,
            help=f"smaller files are placeholders (default {MIN_TABLE_BYTES})",
        )

    def dest_option(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--dest", help=f"the mirror root (default ${DEST_ENV})")

    sp = sub.add_parser("dates", help="list the complete exports, newest first")
    tables_option(sp)
    sp.add_argument("--all", action="store_true", help="show incomplete dates too")
    sp.set_defaults(func=cmd_dates)

    sp = sub.add_parser("fetch", help="download one export into <dest>/<date>/")
    sp.add_argument(
        "--date", type=_date_or_latest, default="latest", help="YYYY-MM-DD, or latest (the default)"
    )
    dest_option(sp)
    tables_option(sp)
    sp.set_defaults(func=cmd_fetch)

    sp = sub.add_parser("verify", help="re-hash an export's files against its export.json")
    sp.add_argument("--date", type=_date, required=True)
    dest_option(sp)
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("head", help="print a table's first rows as JSON")
    sp.add_argument("--table", required=True, choices=KNOWN_TABLES)
    sp.add_argument("--date", type=_date, required=True)
    dest_option(sp)
    sp.add_argument("-n", type=int, default=5, help="rows (default 5)")
    sp.add_argument(
        "--width",
        type=int,
        default=DEFAULT_WIDTH,
        help=f"truncate values to this many characters, 0 for none (default {DEFAULT_WIDTH})",
    )
    sp.set_defaults(func=cmd_head)

    sp = sub.add_parser("stage", help="load an export into stage.sqlite and classify its clusters")
    sp.add_argument("--date", type=_date, required=True)
    dest_option(sp)
    sp.add_argument("--index-manifest", required=True, help="the CAP index's root manifest.json")
    sp.add_argument(
        "--index-dir",
        help="a local copy of that index version (<slug>/<vol>.bin); checks pages, not volumes",
    )
    sp.set_defaults(func=cmd_stage)

    sp = sub.add_parser("text", help="spool the selected clusters' opinions from opinions")
    sp.add_argument("--date", type=_date, required=True)
    dest_option(sp)
    sp.add_argument("--restart", action="store_true", help="discard earlier progress")
    sp.set_defaults(func=cmd_text)

    sp = sub.add_parser("records", help="write records, the export manifest and the delta")
    sp.add_argument("--date", type=_date, required=True)
    dest_option(sp)
    sp.add_argument("--out", help="the bucket layout's root (default <dest>/out)")
    sp.add_argument(
        "--previous", help="the previous export's directory under out/cl/exports, or its manifest"
    )
    sp.add_argument("--jobs", type=int, help="worker processes (default: one per CPU)")
    sp.set_defaults(func=cmd_records)
    return p


def main(argv: Sequence[str] | None = None, out: TextIO | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.func(args, out or sys.stdout)
    except (UsageError, FileNotFoundError, ValueError, OSError, httpx.HTTPError) as exc:
        print(f"stare-cl {args.command}: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:
        print(f"stare-cl {args.command}: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
