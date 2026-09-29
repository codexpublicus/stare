"""CASEMETS: one case's name, citation, printed page range, and pages in the volume."""

from __future__ import annotations

from dataclasses import dataclass

from lxml import etree

from stare_archival._xml import NS_METS, order_of, parse_xml
from stare_archival.errors import MetadataError

_NS = {"m": NS_METS}


@dataclass(frozen=True)
class Case:
    """One case, as its CASEMETS describes it.

    Duplicative cases (CAP's `Case_Body_Duplicative` schema) were redacted in full, and their
    CASEMETS has no case metadata: `case_id`, `name`, `name_abbreviation` and `citation` are
    None and only the page range and pages are known. `first_page` and `last_page` are the
    printed page labels of the casebody. `page_orders` are the METS ORDERs of the case's
    pages and `tiff_file_ids` their TIFF FILEIDs, both in page order; a case can run onto
    pages that start or finish another case.
    """

    case_id: str | None
    name: str | None
    name_abbreviation: str | None
    citation: str | None
    first_page: str | None
    last_page: str | None
    duplicative: bool
    page_orders: tuple[int, ...]
    tiff_file_ids: tuple[str, ...]


def parse_casemets(data: bytes, path: str = "<CASEMETS>") -> Case:
    """Parse a CASEMETS member (gzipped or not)."""
    root = parse_xml(data, path, "CASEMETS")
    body = root.find(".//m:fileGrp[@USE='casebody']//{*}casebody", _NS)
    if body is None:
        raise MetadataError(f"{path}: no casebody")
    duplicative = "Case_Body_Duplicative" in (etree.QName(body).namespace or "")

    case = root.find("m:dmdSec//{*}case", _NS)
    name = case.find("{*}name") if case is not None else None
    # prefer the official citation when a case lists several
    citations = case.findall("{*}citation") if case is not None else []
    official = [c for c in citations if c.get("category") == "official"] or citations

    orders: list[int] = []
    tiffs: list[str] = []
    physical = root.find("m:structMap[@TYPE='physical']", _NS)
    if physical is not None:
        divs = [(order_of(d, path), d) for d in physical.iterfind(".//m:div[@TYPE='page']", _NS)]
        for order, div in sorted(divs, key=lambda od: od[0]):
            orders.append(order)
            tiffs.extend(
                fp.get("FILEID")
                for fp in div.iterfind("m:fptr[@FILEID]", _NS)
                if fp.get("FILEID").startswith("tiff_")
            )

    return Case(
        case_id=case.get("caseid") if case is not None else None,
        name=_text(name),
        name_abbreviation=name.get("abbreviation") if name is not None else None,
        citation=_text(official[0]) if official else None,
        first_page=body.get("firstpage"),
        last_page=body.get("lastpage"),
        duplicative=duplicative,
        page_orders=tuple(orders),
        tiff_file_ids=tuple(tiffs),
    )


def _text(el: etree._Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    return " ".join(el.text.split()) or None
