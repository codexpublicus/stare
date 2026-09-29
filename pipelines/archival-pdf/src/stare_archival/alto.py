"""ALTO: a page's size and its OCR words, with their boxes, in the file's measurement unit."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import cached_property

from lxml import etree

from stare_archival._xml import parse_xml
from stare_archival.errors import MetadataError

# units per inch for the absolute ALTO units; "pixel" depends on the image's resolution
UNITS_PER_INCH = {"mm10": 254.0, "inch1200": 1200.0}
UNITS = ("pixel", *UNITS_PER_INCH)

_TRANSFORM = re.compile(r"RED\.transform=\(([^)]*)\)")


def to_points(value: float, unit: str, dpi: float | None = None) -> float:
    """Convert an ALTO measurement to PDF points (1/72 inch).

    `pixel` needs the scan's resolution (`dpi`); `mm10` (tenths of a millimetre) and
    `inch1200` are absolute and ignore it.
    """
    if unit == "pixel":
        if not dpi or dpi <= 0:
            raise ValueError("pixel units need the image dpi to convert to points")
        return value * 72.0 / dpi
    try:
        return value * 72.0 / UNITS_PER_INCH[unit]
    except KeyError:
        raise MetadataError(f"unknown ALTO MeasurementUnit {unit!r}") from None


@dataclass(frozen=True)
class Word:
    """One ALTO String: its CONTENT and box.

    Hyphenated words are kept as the OCR wrote them: CONTENT is the part on this line, and
    SUBS_TYPE (HypPart1/HypPart2) and SUBS_CONTENT (the whole word) are passed through.
    """

    content: str
    hpos: float
    vpos: float
    width: float
    height: float
    subs_type: str | None = None
    subs_content: str | None = None


@dataclass(frozen=True)
class Line:
    """One ALTO TextLine: its box and its words, in reading order."""

    hpos: float
    vpos: float
    width: float
    height: float
    words: tuple[Word, ...]


@dataclass(frozen=True)
class AltoPage:
    """One ALTO page. Sizes and boxes are in `unit`, origin at the top left.

    `transform` is the R.E.D. deskew matrix (m00, m01, m10, m11, b0, b1) from the OCR
    processing settings, when the file records one: CAP's ALTO coordinates refer to a
    deskewed image, and the matrix maps them back to the original scan.
    """

    unit: str
    width: float
    height: float
    lines: tuple[Line, ...]
    transform: tuple[float, float, float, float, float, float] | None = None

    @cached_property
    def words(self) -> tuple[Word, ...]:
        return tuple(w for line in self.lines for w in line.words)

    def to_points(self, value: float, dpi: float | None = None) -> float:
        return to_points(value, self.unit, dpi)


def parse_alto(data: bytes, path: str = "<ALTO>") -> AltoPage:
    """Parse an ALTO member (gzipped or not; any ALTO namespace version, or none).

    Strings with empty CONTENT are skipped. Missing or non-numeric coordinates raise
    MetadataError.
    """
    root = parse_xml(data, path, "ALTO")
    ns = etree.QName(root).namespace

    def q(tag: str) -> str:
        return f"{{{ns}}}{tag}" if ns else tag

    unit_el = root.find(f"{q('Description')}/{q('MeasurementUnit')}")
    unit = (unit_el.text or "").strip() if unit_el is not None else ""
    unit = unit or "pixel"
    if unit not in UNITS:
        raise MetadataError(f"{path}: unknown ALTO MeasurementUnit {unit!r}")

    page = root.find(f".//{q('Page')}")
    if page is None:
        raise MetadataError(f"{path}: no Page element")
    width, height = _num(page, "WIDTH", path), _num(page, "HEIGHT", path)

    lines = []
    for line in page.iter(q("TextLine")):
        words = []
        for s in line.iterfind(q("String")):
            content = s.get("CONTENT")
            if not content:
                continue
            words.append(
                Word(
                    content=content,
                    hpos=_num(s, "HPOS", path),
                    vpos=_num(s, "VPOS", path),
                    width=_num(s, "WIDTH", path),
                    height=_num(s, "HEIGHT", path),
                    subs_type=s.get("SUBS_TYPE"),
                    subs_content=s.get("SUBS_CONTENT"),
                )
            )
        lines.append(
            Line(
                hpos=_num(line, "HPOS", path),
                vpos=_num(line, "VPOS", path),
                width=_num(line, "WIDTH", path),
                height=_num(line, "HEIGHT", path),
                words=tuple(words),
            )
        )

    return AltoPage(
        unit=unit,
        width=width,
        height=height,
        lines=tuple(lines),
        transform=_transform(root, q, path),
    )


def _num(el: etree._Element, attr: str, path: str) -> float:
    value = el.get(attr)
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        tag = etree.QName(el).localname
        raise MetadataError(f"{path}: {tag} has a missing or bad {attr} {value!r}") from None


def _transform(root, q, path: str) -> tuple[float, float, float, float, float, float] | None:
    for settings in root.iter(q("processingStepSettings")):
        m = _TRANSFORM.search(settings.text or "")
        if m:
            try:
                values = tuple(float(v) for v in m.group(1).split(","))
            except ValueError:
                values = ()
            if len(values) != 6:
                raise MetadataError(f"{path}: bad RED.transform {m.group(0)!r}")
            return values  # type: ignore[return-value]
    return None
