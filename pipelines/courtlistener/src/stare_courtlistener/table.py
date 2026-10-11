"""Reading one table of the bulk export.

The dumps are PostgreSQL ``COPY ... CSV`` output with ``ESCAPE '\\'``: every non-null
value is quoted, a null is an empty unquoted field, and a quote or backslash inside a value
is escaped with a backslash (``\\"``, ``\\\\``) instead of being doubled. Python's default
CSV dialect misreads them, splitting rows wherever a text column holds an escaped quote.
Text columns hold raw newlines (and the odd carriage return), and the opinions table's
HTML columns run past 750 KB, so the field size limit is raised as well.

``QUOTE_NOTNULL`` makes the reader return an unquoted empty field as None (Python 3.13 and
later), so a null and an empty string stay distinct.

Lifted from gorsuch-library's ``clbulk`` module (same author, same license).
"""

from __future__ import annotations

import bz2
import csv
import io
import shutil
import subprocess
import tempfile
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import IO

FIELD_SIZE_LIMIT = 2**31 - 1

Row = dict[str, str | None]


class ExportDialect(csv.Dialect):
    """PostgreSQL ``COPY ... CSV`` with ``ESCAPE '\\'``, as CourtListener writes it."""

    delimiter = ","
    quotechar = '"'
    escapechar = "\\"
    doublequote = False
    skipinitialspace = False
    lineterminator = "\n"
    quoting = csv.QUOTE_NOTNULL
    strict = True


def _decompress_command() -> list[str] | None:
    """``lbzip2 -dc`` when it is installed; it decompresses on every core."""
    found = shutil.which("lbzip2")
    return [found, "-dc"] if found else None


@contextmanager
def open_table(path: Path) -> Iterator[IO[str]]:
    """Open one table as decompressed text: ``.csv.bz2`` streamed, ``.csv`` as is.

    A ``.bz2`` goes through ``lbzip2 -dc`` when it's on PATH, else Python's ``bz2``.

    Yields:
        A text stream with ``newline=""``, as the CSV reader needs.

    Raises:
        OSError: The external decompressor exited non-zero or died on a signal, even when
            its output ended on a record boundary.
    """
    if path.suffix != ".bz2":
        with path.open(encoding="utf-8", newline="") as fh:
            yield fh
        return
    command = _decompress_command()
    if command is None:
        with bz2.open(path, "rt", encoding="utf-8", newline="") as fh:
            yield fh
        return
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(  # noqa: S603 (a resolved lbzip2 and a path)
            [*command, str(path)], stdout=subprocess.PIPE, stderr=errors
        )
        if process.stdout is None:  # pragma: no cover (stdout=PIPE always sets it)
            raise OSError(f"no output pipe from {command[0]}")
        killed = False

        def failure() -> OSError | None:
            code = process.returncode
            if code is None or code == 0 or (killed and code < 0):
                return None
            errors.seek(0)
            detail = errors.read().decode("utf-8", "replace").strip().replace("\n", "; ")
            how = f"killed by signal {-code}" if code < 0 else f"exit {code}"
            return OSError(f"{Path(command[0]).name} failed on {path} ({how}): {detail}")

        try:
            yield io.TextIOWrapper(process.stdout, encoding="utf-8", newline="")
        except BaseException as exc:
            # The caller stopped early (or failed): stop the decompressor.
            killed = True
            process.kill()
            process.wait()
            if (error := failure()) is not None:
                raise error from exc
            raise
        if process.stdout.read(1):
            # The caller left the block without reading to the end.
            killed = True
            process.kill()
        process.wait()
        if (error := failure()) is not None:
            raise error


def read_table(
    fh: Iterable[str], table: str, columns: Sequence[str] | None = None
) -> Iterator[Row]:
    """Parse one export CSV, yielding one dict per record.

    Args:
        fh: The decompressed CSV text, opened with ``newline=""``.
        table: Table name, for error messages.
        columns: Columns to keep (all when None); each must be in the header.

    Yields:
        Column to value; a null is None, an empty string is ``""``.

    Raises:
        ValueError: The file is empty, the header lacks a column, a record has the wrong
            number of fields, or the CSV is malformed (a truncated file ends this way).
            The message names the table, the record number and the line.
    """
    csv.field_size_limit(FIELD_SIZE_LIMIT)
    reader = csv.reader(fh, dialect=ExportDialect)
    try:
        header = next(reader)
    except StopIteration:
        raise ValueError(f"{table}: the file is empty") from None
    except csv.Error as exc:
        raise ValueError(f"{table}: header: {exc}") from exc
    header = [name or "" for name in header]
    keep = list(header) if columns is None else list(columns)
    if missing := [c for c in keep if c not in header]:
        raise ValueError(f"{table}: header lacks {', '.join(missing)}")
    width = len(header)
    picks = [(c, header.index(c)) for c in keep]
    record = 0
    try:
        for record, row in enumerate(reader, start=1):  # noqa: B007 (read in the except)
            if len(row) != width:
                raise ValueError(
                    f"{table}: record {record} (line {reader.line_num}) has {len(row)} "
                    f"fields, expected {width}"
                )
            yield {c: row[i] for c, i in picks}
    except csv.Error as exc:
        raise ValueError(f"{table}: record {record + 1} (line {reader.line_num}): {exc}") from exc
