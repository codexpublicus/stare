"""A volume's metadata, read from its tar: the METS and every case's CASEMETS."""

from __future__ import annotations

from dataclasses import dataclass
from typing import NamedTuple

from stare_archival.casemets import Case, parse_casemets
from stare_archival.errors import MetadataError
from stare_archival.mets import CaseRef, VolumeMets, parse_mets
from stare_archival.tarindex import VolumeTar


class VolumeCase(NamedTuple):
    ref: CaseRef
    case: Case


@dataclass(frozen=True)
class Volume:
    """The parsed metadata of one volume tar.

    `mets_path` and `boxes_path` are tar paths of the volume-level members (BOXES is absent
    from some volumes). `cases` pairs each METS case entry with its parsed CASEMETS, in the
    METS logical order.
    """

    mets_path: str
    boxes_path: str | None
    mets: VolumeMets
    cases: tuple[VolumeCase, ...]


def load_volume(tar: VolumeTar) -> Volume:
    """Find and parse the METS at the tar's top level, then every CASEMETS it lists."""
    root = tar.root
    mets_path = _top_level_member(tar, f"{root}/*_METS.xml*")
    if mets_path is None:
        raise MetadataError(f"no volume METS in the tar (nothing matches {root}/*_METS.xml*)")
    boxes_path = _top_level_member(tar, f"{root}/*_BOXES.xml*")
    mets = parse_mets(tar.read(mets_path), mets_path)
    cases = tuple(
        VolumeCase(ref, parse_casemets(tar.read(ref.path), ref.path)) for ref in mets.cases
    )
    return Volume(mets_path=mets_path, boxes_path=boxes_path, mets=mets, cases=cases)


def _top_level_member(tar: VolumeTar, pattern: str) -> str | None:
    # the METS checksum sidecar (*_METS.md5) doesn't match *.xml*, so it isn't picked up
    found = [m.path for m in tar.index.glob(pattern) if m.path.count("/") == 1]
    if len(found) > 1:
        raise MetadataError(f"more than one member matches {pattern}: {found}")
    return found[0] if found else None
