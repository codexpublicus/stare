"""What CAP's citation index holds: volumes from its root manifest, pages from its ``.bin`` files.

The index (``crates/stare/src/index.rs``) has one directory per CAP reporter slug and, in it,
``<vol>.bin`` (8 bytes per page: the file name of the first case starting there, or all
zeros) and ``<vol>.multi`` (``page,case_file`` lines for further cases at a page; a case
whose first page isn't a number has its lowercased label in place of the number). A
volume CAP split into parts has a folder per part, ``138`` and ``138-2``; the root
manifest's ``reporters`` lists those folders per slug.

A page is held when any part's ``.bin`` has an entry at it or any part's ``.multi`` lists it,
which is the lookup the resolver makes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

ENTRY_SIZE = 8
LONG_NAME = "*"
_ROMAN = re.compile(r"[ivxlcdm]+")


def volume_key(volume: str) -> str:
    """A volume as the index compares it: a number without leading zeros, else the text."""
    text = volume.strip()
    return str(int(text)) if text.isdigit() else text.lower()


def folder_volume(folder: str) -> str:
    """The volume a manifest folder belongs to: ``138-2`` → ``138``."""
    return volume_key(folder.split("-", 1)[0])


def page_key(page: str) -> int | str:
    """A citation's page as the index keys it, following ``index::page_key``.

    ``"1012"`` and ``"01012"`` → 1012; ``"428e"`` → 428 (a page inserted after 428);
    ``"[106]"`` → 106; ``"B174"`` → 174; ``"xxix"`` → ``"xxix"`` (a label).
    """
    raw = page.strip()
    chunk = re.split(r"[=, ]", raw.replace("[", "").replace("]", ""), maxsplit=1)[0]
    unpadded = chunk.lstrip("0")
    if digits := re.match(r"\d+", unpadded):
        return int(digits.group(0))
    if not unpadded and chunk:
        return 0
    if _ROMAN.fullmatch(unpadded.lower()):
        return unpadded.lower()
    if unpadded[:1].isascii() and unpadded[:1].isalpha() and (m := re.match(r"\d+", unpadded[1:])):
        return int(m.group(0))
    return raw.lstrip("0").lower() or raw.lower()


@dataclass
class CapIndex:
    """The volumes one index version holds, from its root ``manifest.json``."""

    version: str
    base: str
    folders: dict[str, dict[str, list[str]]]
    """slug → volume → its folders (``["138", "138-2"]``)."""

    @classmethod
    def load(cls, path: Path) -> CapIndex:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        folders: dict[str, dict[str, list[str]]] = {}
        for slug, vols in manifest["reporters"].items():
            by_volume = folders.setdefault(slug, {})
            for folder in vols:
                by_volume.setdefault(folder_volume(folder), []).append(folder)
        return cls(manifest.get("version", ""), manifest.get("base", ""), folders)

    def holds_volume(self, slug: str, volume: str) -> bool:
        return volume_key(volume) in self.folders.get(slug, {})

    def volume_count(self) -> int:
        return sum(len(v) for v in self.folders.values())


@dataclass(frozen=True)
class Match:
    """A CAP case at a page: the volume folder (``138-2`` for a second part) and file name."""

    folder: str
    case_file: str


@dataclass
class _Volume:
    bins: dict[str, bytes]
    multi: dict[int | str, list[Match]]


@dataclass
class PageIndex:
    """Page lookups against a local copy of one index version (the directory holding
    ``<slug>/<vol>.bin``), one volume's files in memory at a time.

    A volume the manifest lists but whose ``.bin`` files are all absent from ``root`` can't
    be checked; ``lookup`` returns None for it and it is recorded in ``missing``.
    """

    root: Path
    index: CapIndex
    _key: tuple[str, str] | None = None
    _volume: _Volume = field(default_factory=lambda: _Volume({}, {}))
    missing: set[tuple[str, str]] = field(default_factory=set)
    """``(slug, folder)`` of the ``.bin`` files the manifest lists that ``root`` lacks."""

    def _load(self, slug: str, volume: str) -> _Volume:
        if self._key == (slug, volume):
            return self._volume
        loaded = _Volume({}, {})
        for folder in self.index.folders.get(slug, {}).get(volume, []):
            bin_path = self.root / slug / f"{folder}.bin"
            if not bin_path.exists():
                self.missing.add((slug, folder))
                continue
            loaded.bins[folder] = bin_path.read_bytes()
            multi_path = self.root / slug / f"{folder}.multi"
            if multi_path.exists():
                for line in multi_path.read_text(encoding="utf-8").splitlines():
                    page, _, case_file = line.partition(",")
                    key = int(page) if page.isdigit() else page
                    loaded.multi.setdefault(key, []).append(Match(folder, case_file))
        self._key, self._volume = (slug, volume), loaded
        return loaded

    def lookup(self, slug: str, volume: str, page: str) -> list[Match] | None:
        """The CAP cases the resolver finds at this page, in folder order: empty when there
        are none, None when the volume's files aren't in ``root``."""
        loaded = self._load(slug, volume_key(volume))
        if not loaded.bins:
            return None
        key = page_key(page)
        found: list[Match] = []
        if isinstance(key, int):
            start = key * ENTRY_SIZE
            for folder, data in loaded.bins.items():
                entry = data[start : start + ENTRY_SIZE]
                if len(entry) == ENTRY_SIZE and any(entry):
                    name = entry.split(b"\0", 1)[0].decode("utf-8", "replace")
                    if name != LONG_NAME:
                        found.append(Match(folder, name))
        for match in loaded.multi.get(key, []):
            if match not in found:
                found.append(match)
        return found

    def holds_page(self, slug: str, volume: str, page: str) -> bool:
        """Whether the resolver finds a CAP case at this page of this volume."""
        return bool(self.lookup(slug, volume, page))
