"""The volume METS: page order, page labels, each page's files, and the case list."""

from __future__ import annotations

import posixpath
from dataclasses import dataclass, field

from stare_archival._xml import NS_METS, NS_XLINK, order_of, parse_xml
from stare_archival.errors import MetadataError
from stare_archival.tarindex import resolve_href

_NS = {"m": NS_METS}
_HREF = f"{{{NS_XLINK}}}href"


@dataclass(frozen=True)
class Page:
    """One physical page, in the METS physical structMap.

    `tiff`, `jpg` and `alto` are tar paths (None when the METS lists no such file for the
    page); `file_ids` maps each file kind (the FILEID prefix: tiff, jpg, alto) to its FILEID.
    """

    order: int
    label: str | None
    tiff: str | None
    jpg: str | None
    alto: str | None
    file_ids: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CaseRef:
    """One case in the METS logical structMap: its ORDER and its CASEMETS member."""

    order: int
    file_id: str
    path: str


@dataclass(frozen=True)
class VolumeMets:
    barcode: str | None
    reporter: str | None
    volume_number: str | None
    pages: tuple[Page, ...]
    cases: tuple[CaseRef, ...]

    def page_for_file_id(self, file_id: str) -> Page:
        """The page that has `file_id` (e.g. `tiff_00436_0`); KeyError if none."""
        for page in self.pages:
            if file_id in page.file_ids.values():
                return page
        raise KeyError(file_id)


def parse_mets(data: bytes, path: str) -> VolumeMets:
    """Parse a volume METS member (gzipped or not) found at tar path `path`.

    File hrefs resolve against the METS member's directory, so pages and cases come back
    with tar paths ready for `VolumeTar.read`.
    """
    root = parse_xml(data, path, "METS")
    base = posixpath.dirname(path)
    hrefs: dict[str, str] = {}
    for f in root.iterfind(".//m:fileSec//m:file", _NS):
        loc = f.find("m:FLocat", _NS)
        if loc is not None and f.get("ID") and loc.get(_HREF):
            hrefs[f.get("ID")] = resolve_href(base, loc.get(_HREF))

    physical = root.find("m:structMap[@TYPE='physical']", _NS)
    if physical is None:
        raise MetadataError(f"{path}: no physical structMap")
    pages: dict[int, Page] = {}
    for div in physical.iterfind(".//m:div[@TYPE='page']", _NS):
        order = order_of(div, path)
        if order in pages:
            raise MetadataError(f"{path}: duplicate page ORDER {order}")
        file_ids: dict[str, str] = {}
        files: dict[str, str] = {}
        for fptr in div.iterfind("m:fptr[@FILEID]", _NS):
            fid = fptr.get("FILEID")
            if fid not in hrefs:
                raise MetadataError(f"{path}: page {order} points at unknown file {fid}")
            kind = fid.split("_", 1)[0]
            file_ids[kind] = fid
            files[kind] = hrefs[fid]
        pages[order] = Page(
            order=order,
            label=div.get("ORDERLABEL"),
            tiff=files.get("tiff"),
            jpg=files.get("jpg"),
            alto=files.get("alto"),
            file_ids=file_ids,
        )

    cases: list[CaseRef] = []
    logical = root.find("m:structMap[@TYPE='logical']", _NS)
    if logical is not None:
        for div in logical.iterfind(".//m:div[@TYPE='case']", _NS):
            fptr = div.find("m:fptr[@FILEID]", _NS)
            fid = fptr.get("FILEID") if fptr is not None else None
            if fid not in hrefs:
                raise MetadataError(f"{path}: case div points at unknown file {fid}")
            cases.append(CaseRef(order=order_of(div, path), file_id=fid, path=hrefs[fid]))

    volume = root.find(".//m:dmdSec//{*}volume", _NS)
    reporter = volume.find("{*}reporter") if volume is not None else None
    return VolumeMets(
        barcode=volume.get("barcode") if volume is not None else None,
        reporter=reporter.get("abbreviation") if reporter is not None else None,
        volume_number=reporter.get("volnumber") if reporter is not None else None,
        pages=tuple(pages[k] for k in sorted(pages)),
        cases=tuple(sorted(cases, key=lambda c: c.order)),
    )
