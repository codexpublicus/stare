"""XML parsing shared by the METS, CASEMETS and ALTO readers."""

from lxml import etree

from stare_archival.errors import MetadataError
from stare_archival.tarindex import gunzip_member

NS_METS = "http://www.loc.gov/METS/"
NS_XLINK = "http://www.w3.org/1999/xlink"

_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, remove_comments=True)


def parse_xml(data: bytes, path: str, kind: str) -> etree._Element:
    """Parse a member's XML, gunzipping it first when it is gzip data."""
    raw = gunzip_member(data, path)
    try:
        return etree.fromstring(raw, _PARSER)
    except etree.XMLSyntaxError as e:
        raise MetadataError(f"{path}: not valid {kind} XML ({e})") from None


def order_of(div: etree._Element, path: str) -> int:
    """A METS div's ORDER attribute as an int."""
    order = div.get("ORDER")
    try:
        return int(order)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        kind = div.get("TYPE") or "METS"
        raise MetadataError(f"{path}: {kind} div has a missing or bad ORDER {order!r}") from None
