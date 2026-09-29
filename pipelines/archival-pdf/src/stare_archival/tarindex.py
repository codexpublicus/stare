"""Random access to a CAP volume tar through its .tar.csv manifest.

The mirror publishes, next to every `<volume>.tar`, a `<volume>.tar.csv` with one row per
member: `path,offset,size`, where `offset` is where the member's data starts. Reading a member
is one seek and one read; nothing is extracted.
"""

from __future__ import annotations

import csv
import fnmatch
import gzip
import io
import os
import posixpath
import zlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import IO, BinaryIO, Self

from stare_archival.errors import (
    MemberNotFoundError,
    MemberReadError,
    MetadataError,
    TarIndexError,
)

BLOCK = 512
GZIP_MAGIC = b"\x1f\x8b"


@dataclass(frozen=True, slots=True)
class Member:
    """One row of a .tar.csv: a member's path and where its data sits in the tar."""

    path: str
    offset: int
    size: int


class TarIndex:
    """The members of one volume tar, keyed by path, in manifest order."""

    def __init__(self, members: Iterable[Member]) -> None:
        self._members: dict[str, Member] = {}
        for m in members:
            if m.path in self._members:
                raise TarIndexError(f"duplicate path in tar index: {m.path}")
            self._members[m.path] = m

    @classmethod
    def from_csv(cls, source: str | os.PathLike[str] | bytes | IO[bytes] | IO[str]) -> Self:
        """Parse a .tar.csv from a path, its bytes, or an open file (binary or text).

        CRLF and LF line endings, a UTF-8 BOM and trailing blank lines are accepted.
        """
        if isinstance(source, str | os.PathLike):
            raw: bytes | str = Path(source).read_bytes()
        elif isinstance(source, bytes):
            raw = source
        else:
            raw = source.read()
        text = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw.removeprefix("﻿")
        rows = csv.reader(io.StringIO(text, newline=""))
        header = next(rows, None)
        if header is None:
            raise TarIndexError("tar index is empty")
        if header != ["path", "offset", "size"]:
            raise TarIndexError(f"tar index header must be path,offset,size, got {header!r}")
        return cls(_parse_row(row, lineno) for lineno, row in enumerate(rows, start=2) if row)

    def __len__(self) -> int:
        return len(self._members)

    def __iter__(self) -> Iterator[Member]:
        return iter(self._members.values())

    def __contains__(self, path: object) -> bool:
        return path in self._members

    def __getitem__(self, path: str) -> Member:
        try:
            return self._members[path]
        except KeyError:
            raise MemberNotFoundError(f"not in tar index: {path}") from None

    @property
    def root(self) -> str:
        """The single top-level directory of the tar (e.g. `32044109578831_redacted`)."""
        tops = {m.path.split("/", 1)[0] for m in self}
        if len(tops) != 1:
            raise TarIndexError(f"expected one top-level directory, found {sorted(tops)}")
        return tops.pop()

    def glob(self, pattern: str) -> list[Member]:
        """Members whose path matches a shell-style pattern, in manifest order."""
        return [m for m in self if fnmatch.fnmatchcase(m.path, pattern)]


def _parse_row(row: list[str], lineno: int) -> Member:
    if len(row) != 3:
        raise TarIndexError(f"tar index line {lineno}: expected 3 fields, got {len(row)}")
    path, offset_s, size_s = row
    if not path:
        raise TarIndexError(f"tar index line {lineno}: empty path")
    try:
        offset, size = int(offset_s), int(size_s)
    except ValueError:
        raise TarIndexError(
            f"tar index line {lineno}: offset and size must be integers, got {row!r}"
        ) from None
    if offset < BLOCK or offset % BLOCK or size < 0:
        raise TarIndexError(
            f"tar index line {lineno}: offset must be a positive multiple of {BLOCK} "
            f"and size non-negative, got offset={offset} size={size}"
        )
    return Member(path, offset, size)


class VolumeTar:
    """A volume tar opened for member reads by byte range.

    `fileobj` can be any seekable binary file. With `check_headers` (the default) every read
    also checks the 512-byte tar header before the member: valid checksum, the same size, and
    a name that matches the path. That catches a manifest that doesn't belong to the tar.
    """

    def __init__(self, fileobj: BinaryIO, index: TarIndex, *, check_headers: bool = True):
        self._f = fileobj
        self.index = index
        self.check_headers = check_headers

    @classmethod
    def open(
        cls,
        tar_path: str | os.PathLike[str],
        csv_path: str | os.PathLike[str] | None = None,
        *,
        check_headers: bool = True,
    ) -> Self:
        """Open a tar and its manifest (by default `<tar_path>.csv`)."""
        csv_path = csv_path if csv_path is not None else f"{os.fspath(tar_path)}.csv"
        index = TarIndex.from_csv(csv_path)
        return cls(open(tar_path, "rb"), index, check_headers=check_headers)  # noqa: SIM115

    @property
    def root(self) -> str:
        return self.index.root

    def read(self, path: str) -> bytes:
        """The member's bytes exactly as stored in the tar."""
        m = self.index[path]
        if self.check_headers:
            self._f.seek(m.offset - BLOCK)
            _check_header(self._f.read(BLOCK), m)
        else:
            self._f.seek(m.offset)
        data = self._f.read(m.size) if m.size else b""
        if len(data) != m.size:
            raise MemberReadError(
                f"short read of {path}: wanted {m.size} bytes at offset {m.offset}, "
                f"got {len(data)} (truncated tar?)"
            )
        return data

    def read_decoded(self, path: str) -> bytes:
        """The member's bytes, gunzipped if the member is gzip data."""
        return gunzip_member(self.read(path), path)

    def close(self) -> None:
        self._f.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _check_header(header: bytes, m: Member) -> None:
    if len(header) != BLOCK:
        raise MemberReadError(f"short read of the tar header for {m.path} (truncated tar?)")
    try:
        stored = int(header[148:156].split(b"\0", 1)[0].strip() or b"0", 8)
        size = int(header[124:136].split(b"\0", 1)[0].strip() or b"0", 8)
    except ValueError:
        raise MemberReadError(f"no tar header before {m.path} at offset {m.offset}") from None
    computed = sum(header[:148]) + 8 * 32 + sum(header[156:])
    if stored != computed:
        raise MemberReadError(f"no valid tar header before {m.path} at offset {m.offset}")
    name = header[:100].split(b"\0", 1)[0].decode("utf-8", "replace")
    if header[257:263] == b"ustar\0" and header[345] != 0:  # POSIX ustar name prefix
        prefix = header[345:500].split(b"\0", 1)[0].decode("utf-8", "replace")
        name = f"{prefix}/{name}"
    name = name.rstrip("/")
    # GNU tar truncates long names in the header and stores the full name in an earlier block
    name_ok = name == m.path or (len(name) >= 99 and m.path.startswith(name))
    if not name_ok or size != m.size:
        raise MemberReadError(
            f"tar header at offset {m.offset - BLOCK} is for {name!r} ({size} bytes), "
            f"not {m.path!r} ({m.size} bytes): the index doesn't match the tar"
        )


def gunzip_member(data: bytes, path: str = "<member>") -> bytes:
    """Gunzip `data` if it starts with the gzip magic number, else return it unchanged."""
    if not data.startswith(GZIP_MAGIC):
        return data
    try:
        return gzip.decompress(data)
    except (OSError, EOFError, zlib.error) as e:
        raise MetadataError(f"{path}: corrupt gzip data ({e})") from None


def resolve_href(base_dir: str, href: str) -> str:
    """Resolve a METS/CASEMETS xlink:href against the member's directory to a tar path.

    The result has to stay inside the volume's top-level directory.
    """
    if "://" in href or href.startswith("/"):
        raise MetadataError(f"href must be a relative path inside the volume: {href!r}")
    resolved = posixpath.normpath(posixpath.join(base_dir, href))
    top = base_dir.split("/", 1)[0]
    if resolved.split("/", 1)[0] != top or resolved == top:
        raise MetadataError(f"href {href!r} from {base_dir!r} leaves the volume directory")
    return resolved
