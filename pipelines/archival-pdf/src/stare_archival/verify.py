"""Verify one volume's archival PDF against the tar it was built from.

`verify_volume` runs these checks, in this order (`CHECKS`), and reports each as pass, fail or
skipped, with a structured `Failure` (check, PDF page, METS order, page label, message) for
every problem it finds:

- source_sha256: the tar's SHA-256 equals the mirror's `<tar>.sha256` (when there is one) and
  the stare:sourceSha256 the PDF's XMP records.
- structure: the PDF has one page per METS page, labelled as the METS labels it.
- no_jbig2_globals: no object anywhere in the PDF has a /JBIG2Globals entry.
- image_streams: each page draws exactly one 1-bit DeviceGray image (JBIG2Decode or
  CCITTFaxDecode, no Decode array or masks) the size of its TIFF, scaled to a MediaBox of the
  TIFF's size at its resolution; JBIG2 streams are generic region coding only; and the page
  draws nothing else (any text is in render mode 3, invisible).
- image_pixels: every page image decodes bit-for-bit to its TIFF. JBIG2 is decoded by poppler
  (`pdfimages -png`), CCITT G4 by pikepdf.
- text_chars: per page, the characters `pdftotext -bbox` extracts equal, as a multiset, the
  ALTO words' characters as the text layer writes them, after NFKC normalization and with
  whitespace and hyphens removed (reading order and word breaks differ between the two).
  poppler drops glyphs it takes for fake bold, which the layer produces only in words
  squeezed below 0.1 em per character and in words the ALTO lists twice at one place; those
  words' characters may go missing (`at_risk_words`), but nothing may be added.
- text_positions: per page, every word pdftotext extracts must be accounted for by the ALTO
  at its position, within `tolerance` points (default 1.0) on its left and right edges and
  its vertical centre: a word with the same text and box, a part of one word inside that
  word's box, or several adjacent words run together. pdftotext's vertical extent comes from
  the font's ascent and descent, not the box, so the top and bottom edges aren't compared.
  On the fixture and on two full volumes (a2d/152, us/10) every exact match is within 0.85 pt.
- pdfa: veraPDF validates the file as PDF/A-3b, when a `VeraPdf` is given; skipped otherwise.

When the page count is wrong, the per-page checks are skipped rather than compared against
the wrong pages. A PDF that can't be opened, a missing tool, or a `.tar.sha256` that can't be
read raise instead (`VerifyError`, `ToolError`): there's nothing to report on.
"""

from __future__ import annotations

import bisect
import hashlib
import io
import os
import re
import tempfile
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pikepdf
from lxml import etree
from PIL import Image, ImageChops

from stare_archival.alto import parse_alto
from stare_archival.encoders import check_jbig2_generic, read_tiff
from stare_archival.errors import ArchivalError, ToolError, VerifyError
from stare_archival.external import Poppler, VeraPdf
from stare_archival.mets import Page
from stare_archival.pdfa import STARE_NS
from stare_archival.tarindex import VolumeTar
from stare_archival.textlayer import layer_text
from stare_archival.volume import load_volume

CHECKS = (
    "source_sha256",
    "structure",
    "no_jbig2_globals",
    "image_streams",
    "image_pixels",
    "text_chars",
    "text_positions",
    "pdfa",
)
PAGE_CHECKS = ("image_streams", "image_pixels", "text_chars", "text_positions")
DEFAULT_TOLERANCE_PT = 1.0
DUP_PRI_DELTA = 0.1  # poppler's dupMaxPriDelta: along the line, in em
DUP_SEC_DELTA = 0.2  # poppler's dupMaxSecDelta: across it
BOX_TOLERANCE_PT = 0.01
HYPHENS = "-\u00ad\u2010\u2011"  # hyphen-minus, soft, hyphen, non-breaking
_IGNORED = re.compile(rf"[\s{re.escape(HYPHENS)}]")
_SHA256_LINE = re.compile(r"([0-9a-fA-F]{64})(?:(?:  | \*).+)?")
_PDFIMAGES_FILE = re.compile(r"-(\d+)-(\d+)\.png$")
_XHTML = "{http://www.w3.org/1999/xhtml}"
_XMP_NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "stare": STARE_NS,
}
# content stream operators an archival page may use: the image, and invisible text
_ALLOWED_OPERATORS = frozenset({"q", "Q", "cm", "Do", "BT", "ET", "Tr", "Tf", "Tz", "Tm", "Tj"})
_MAX_LISTED = 10
_SAFE_XML = etree.XMLParser(huge_tree=True, resolve_entities=False, no_network=True)


@dataclass(frozen=True)
class Failure:
    """One problem a check found. `page` is the 1-based page number in the PDF, `order` the
    METS ORDER and `label` the printed page label; all three are None for document-wide
    problems."""

    check: str
    message: str
    page: int | None = None
    order: int | None = None
    label: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "check": self.check,
            "page": self.page,
            "order": self.order,
            "label": self.label,
            "message": self.message,
        }

    def __str__(self) -> str:
        if self.page is None:
            return f"{self.check}: {self.message}"
        where = f"page {self.page} (order {self.order}, label {self.label})"
        return f"{self.check}: {where}: {self.message}"


@dataclass(frozen=True)
class CheckResult:
    """A check's outcome: status "pass", "fail" or "skipped", counts and settings in
    `detail`, and every failure it found."""

    name: str
    status: str
    detail: Mapping[str, Any] = field(default_factory=dict)
    failures: tuple[Failure, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "detail": dict(self.detail),
            "failures": [f.to_dict() for f in self.failures],
        }


@dataclass(frozen=True)
class VerifyReport:
    """What `verify_volume` found. The volume id, barcode, encoder and embedded source hash
    are read from the PDF's XMP (None when it has none); `tools` has the external tools'
    versions."""

    pdf_path: Path
    tar_path: Path
    volume_id: str | None
    barcode: str | None
    page_count: int
    labels: tuple[str | None, ...]
    output_sha256: str
    output_size: int
    source_sha256: str
    recorded_source_sha256: str | None
    embedded_source_sha256: str | None
    encoder: str | None
    encoder_settings: str | None
    checks: tuple[CheckResult, ...]
    tools: Mapping[str, str]

    @property
    def ok(self) -> bool:
        return all(c.status != "fail" for c in self.checks)

    @property
    def failures(self) -> tuple[Failure, ...]:
        return tuple(f for c in self.checks for f in c.failures)

    def check(self, name: str) -> CheckResult:
        for c in self.checks:
            if c.name == name:
                return c
        raise KeyError(name)

    def to_dict(self) -> dict[str, Any]:
        return {
            "pdf_path": str(self.pdf_path),
            "tar_path": str(self.tar_path),
            "volume_id": self.volume_id,
            "barcode": self.barcode,
            "ok": self.ok,
            "page_count": self.page_count,
            "output_sha256": self.output_sha256,
            "output_size": self.output_size,
            "source_sha256": self.source_sha256,
            "recorded_source_sha256": self.recorded_source_sha256,
            "embedded_source_sha256": self.embedded_source_sha256,
            "encoder": self.encoder,
            "encoder_settings": self.encoder_settings,
            "checks": [c.to_dict() for c in self.checks],
            "tools": dict(self.tools),
        }


# --- the text comparison ----------------------------------------------------------------


@dataclass(frozen=True)
class ExtractedWord:
    """A word and its box in points, top-left origin (pdftotext's coordinates)."""

    text: str
    x0: float
    top: float
    x1: float
    bottom: float

    @property
    def centre(self) -> float:
        return (self.top + self.bottom) / 2


@dataclass(frozen=True)
class Misplaced:
    """An extracted word that no ALTO word accounts for at its position. `deviation` is the
    distance to the nearest ALTO word of the same text, None when there's none."""

    text: str
    x0: float
    top: float
    deviation: float | None


@dataclass(frozen=True)
class PageText:
    """The comparison of one page's ALTO words with the words pdftotext extracted.

    Characters: `missing` are ALTO characters pdftotext didn't return, beyond those poppler
    may drop (`at_risk`, see `at_risk_words`; `dropped` of those it did drop); `extra` are
    characters it returned that the ALTO doesn't have.

    Positions: each extracted word is `exact` (an ALTO word with the same text and box, within
    the tolerance), `split` (part of one ALTO word and inside its box: pdftotext breaks words
    at spaces and at overlapping glyphs), `merged` (adjacent ALTO words run together, spanning
    their boxes) or `misplaced`."""

    missing: Mapping[str, int]
    extra: Mapping[str, int]
    characters: int
    at_risk: int
    dropped: int
    exact: int
    split: int
    merged: int
    misplaced: tuple[Misplaced, ...]
    max_deviation: float

    @property
    def chars_ok(self) -> bool:
        return not self.missing and not self.extra

    @property
    def positions_ok(self) -> bool:
        return not self.misplaced


def _squeezed(word: ExtractedWord) -> bool:
    size = word.bottom - word.top
    return bool(word.text) and (word.x1 - word.x0) / len(word.text) < DUP_PRI_DELTA * size


def at_risk_words(words: Sequence[ExtractedWord]) -> list[bool]:
    """Which ALTO words poppler's duplicate-text suppression may take characters from.

    poppler drops a glyph drawn within a tenth of an em (along the line; a fifth across it)
    of an identical glyph, taking it for fake bold (`dupMaxPriDelta` and `dupMaxSecDelta` in
    TextOutputDev.cc). The text layer triggers that in two cases: a word squeezed into a box
    narrower than 0.1 em per character (OCR of a margin note, say), whose repeated letters
    overlap, and a word the ALTO lists twice at the same place, whose second copy overlaps
    the first. Which glyphs go depends on poppler's word building, so those words' characters
    are an allowance, not a requirement."""
    risky = [_squeezed(w) for w in words]
    seen: dict[str, list[ExtractedWord]] = defaultdict(list)
    for i, w in enumerate(words):
        size = w.bottom - w.top
        for other in seen[w.text]:
            if (
                abs(other.x0 - w.x0) < DUP_PRI_DELTA * size
                and abs(other.bottom - w.bottom) < DUP_SEC_DELTA * size
            ):
                risky[i] = True
                break
        seen[w.text].append(w)
    return risky


def _normalize(text: str) -> str:
    return _IGNORED.sub("", unicodedata.normalize("NFKC", text))


def _is_subsequence(part: str, whole: str) -> bool:
    chars = iter(whole)
    return all(ch in chars for ch in part)


def _deviation(a: ExtractedWord, b: ExtractedWord) -> float:
    return max(abs(a.x0 - b.x0), abs(a.x1 - b.x1), abs(a.centre - b.centre))


class _AltoLines:
    """A page's ALTO words indexed by text and by the vertical centre of their boxes."""

    def __init__(self, words: Sequence[ExtractedWord]) -> None:
        self.words = sorted(words, key=lambda w: w.centre)
        self.centres = [w.centre for w in self.words]
        self.by_text: dict[str, list[ExtractedWord]] = defaultdict(list)
        for w in self.words:
            self.by_text[unicodedata.normalize("NFKC", w.text)].append(w)

    def near(self, centre: float, reach: float) -> list[ExtractedWord]:
        lo = bisect.bisect_left(self.centres, centre - reach)
        hi = bisect.bisect_right(self.centres, centre + reach)
        return self.words[lo:hi]


def _place(word: ExtractedWord, alto: _AltoLines, tolerance: float) -> tuple[str, float | None]:
    """How an extracted word is accounted for: ("exact", deviation), ("split", None),
    ("merged", None), or ("misplaced", deviation from the nearest same-text ALTO word)."""
    text = unicodedata.normalize("NFKC", word.text)
    same = alto.by_text.get(text, ())
    nearest = min((_deviation(word, a) for a in same), default=None)
    if nearest is not None and nearest <= tolerance:
        return "exact", nearest
    line = alto.near(word.centre, max(tolerance, (word.bottom - word.top) / 2))
    for a in line:
        if (
            a.x0 - tolerance <= word.x0
            and word.x1 <= a.x1 + tolerance
            and abs(a.centre - word.centre) <= tolerance
            and _is_subsequence(text, unicodedata.normalize("NFKC", a.text))
        ):
            return "split", None
    parts = sorted(
        (a for a in line if a.x0 >= word.x0 - tolerance and a.x1 <= word.x1 + tolerance),
        key=lambda a: a.x0,
    )
    if (
        len(parts) > 1
        and _normalize("".join(a.text for a in parts)) == _normalize(text)
        and abs(parts[0].x0 - word.x0) <= tolerance
        and abs(max(a.x1 for a in parts) - word.x1) <= tolerance
    ):
        return "merged", None
    return "misplaced", nearest


def compare_page_text(
    expected: Sequence[ExtractedWord], got: Sequence[ExtractedWord], *, tolerance: float
) -> PageText:
    """Compare a page's ALTO words (`expected`, as the text layer writes them) with the words
    pdftotext extracted (`got`): the characters as multisets (see `_normalize` and
    `at_risk_words`), and each extracted word's position against the ALTO words there."""
    risky = at_risk_words(expected)
    required = Counter(
        _normalize("".join(w.text for w, r in zip(expected, risky, strict=True) if not r))
    )
    allowed = Counter(
        _normalize("".join(w.text for w, r in zip(expected, risky, strict=True) if r))
    )
    have = Counter(_normalize("".join(w.text for w in got)))
    short = (required + allowed) - have
    alto = _AltoLines(expected)
    counts: Counter[str] = Counter()
    worst = 0.0
    misplaced = []
    for word in got:
        kind, deviation = _place(word, alto, tolerance)
        counts[kind] += 1
        if kind == "exact" and deviation is not None:
            worst = max(worst, deviation)
        elif kind == "misplaced":
            misplaced.append(Misplaced(word.text, word.x0, word.top, deviation))
    return PageText(
        missing=dict(short - allowed),
        extra=dict(have - (required + allowed)),
        characters=sum((required + allowed).values()),
        at_risk=sum(allowed.values()),
        dropped=sum((short & allowed).values()),
        exact=counts["exact"],
        split=counts["split"],
        merged=counts["merged"],
        misplaced=tuple(misplaced),
        max_deviation=worst,
    )


# --- the image comparison ---------------------------------------------------------------


def _as_bitonal(im: Image.Image) -> Image.Image:
    if im.mode == "1":
        return im
    return im.convert("L").convert("1", dither=Image.Dither.NONE)


def compare_bitonal(expected: Image.Image, got: Image.Image) -> str | None:
    """None when `got` has exactly `expected`'s pixels (anything not 1-bit is thresholded at
    50%, without dithering); otherwise what differs."""
    if expected.size != got.size:
        return (
            f"size {got.size[0]}x{got.size[1]}, the TIFF is {expected.size[0]}x{expected.size[1]}"
        )
    a, b = _as_bitonal(expected), _as_bitonal(got)
    if a.tobytes() == b.tobytes():
        return None
    diff = ImageChops.logical_xor(a, b)
    count = sum(diff.histogram()[1:])
    x0, y0, x1, y1 = diff.getbbox() or (0, 0, 0, 0)
    noun = "pixel differs" if count == 1 else "pixels differ"
    return f"{count} {noun}, within x {x0}-{x1 - 1}, y {y0}-{y1 - 1}"


# --- sha256 sidecars --------------------------------------------------------------------


def read_sha256_file(path: str | os.PathLike[str]) -> str:
    """The SHA-256 in a `.sha256` file: a bare hex digest (the mirror's format) or one
    `sha256sum` line for a single file. Returned in lower case."""
    path = Path(path)
    try:
        text = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise VerifyError(f"{path}: can't read the recorded sha256 ({exc})") from exc
    m = _SHA256_LINE.fullmatch(text)
    if m is None:
        raise VerifyError(f"{path}: not a sha256 digest or a sha256sum line: {text[:80]!r}")
    return m.group(1).lower()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- verify_volume ----------------------------------------------------------------------


@dataclass(frozen=True)
class _Xmp:
    volume_id: str | None = None
    barcode: str | None = None
    source_sha256: str | None = None
    encoder: str | None = None
    encoder_settings: str | None = None


def _read_xmp(pdf: pikepdf.Pdf) -> _Xmp:
    if "/Metadata" not in pdf.Root:
        return _Xmp()
    try:
        tree = etree.fromstring(pdf.Root.Metadata.read_bytes(), _SAFE_XML)
    except (etree.XMLSyntaxError, pikepdf.PdfError):
        return _Xmp()

    def text(prop: str) -> str | None:
        found = tree.xpath(f"//rdf:Description/{prop}", namespaces=_XMP_NS)
        return found[0].text if found else None

    return _Xmp(
        volume_id=text("stare:volumeId") or text("dc:source"),
        barcode=text("stare:barcode"),
        source_sha256=text("stare:sourceSha256"),
        encoder=text("stare:imageEncoder"),
        encoder_settings=text("stare:imageEncoderSettings"),
    )


def _result(name: str, failures: Iterable[Failure], detail: Mapping[str, Any]) -> CheckResult:
    failures = tuple(failures)
    return CheckResult(name, "fail" if failures else "pass", dict(detail), failures)


def _check_source(
    tar_path: Path, sha256_path: Path | None, embedded: str | None, computed: str
) -> tuple[CheckResult, str | None]:
    failures = []
    recorded = read_sha256_file(sha256_path) if sha256_path is not None else None
    if recorded is not None and recorded != computed:
        failures.append(
            Failure(
                "source_sha256",
                f"{sha256_path.name} records {recorded}, the tar's sha256 is {computed}",
            )
        )
    if embedded is None:
        failures.append(Failure("source_sha256", "the PDF records no source sha256"))
    elif embedded.lower() != computed:
        failures.append(
            Failure(
                "source_sha256",
                f"the PDF records {embedded} as its source sha256, the tar's is {computed}",
            )
        )
    detail = {
        "tar": tar_path.name,
        "computed": computed,
        "recorded": recorded,
        "recorded_file": sha256_path.name if sha256_path is not None else None,
        "embedded": embedded,
    }
    return _result("source_sha256", failures, detail), recorded


def _label(page: Page) -> str:
    return page.label or str(page.order)


def _check_structure(pdf: pikepdf.Pdf, pages: Sequence[Page]) -> CheckResult:
    failures = []
    if len(pdf.pages) != len(pages):
        failures.append(
            Failure("structure", f"the PDF has {len(pdf.pages)} pages, the METS lists {len(pages)}")
        )
    else:
        for i, (pdf_page, page) in enumerate(zip(pdf.pages, pages, strict=True)):
            if pdf_page.label != _label(page):
                failures.append(
                    Failure(
                        "structure",
                        f"page label {pdf_page.label!r}, the METS has {_label(page)!r}",
                        i + 1,
                        page.order,
                        page.label,
                    )
                )
    return _result("structure", failures, {"pages": len(pdf.pages), "mets_pages": len(pages)})


def _walk(obj: pikepdf.Object) -> Iterator[pikepdf.Dictionary]:
    """Every dictionary directly inside `obj` (a stream's dictionary included), not following
    indirect references: each indirect object is visited on its own."""
    if isinstance(obj, pikepdf.Stream):
        obj = obj.stream_dict
    if isinstance(obj, pikepdf.Dictionary):
        yield obj
        children = [obj[key] for key in obj.keys()]  # noqa: SIM118 (a pikepdf Dictionary)
    elif isinstance(obj, pikepdf.Array):
        children = list(obj)
    else:
        return
    for child in children:
        if isinstance(child, (pikepdf.Dictionary, pikepdf.Array)) and not child.is_indirect:
            yield from _walk(child)


def _check_no_jbig2_globals(pdf: pikepdf.Pdf) -> CheckResult:
    failures = []
    for obj in pdf.objects:
        if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
            continue
        if any("/JBIG2Globals" in d for d in _walk(obj)):
            failures.append(
                Failure("no_jbig2_globals", f"object {obj.objgen} has a /JBIG2Globals entry")
            )
    return _result("no_jbig2_globals", failures, {"objects": len(pdf.objects)})


def _image_problems(
    pdf_page: pikepdf.Page, width: int, height: int, dpi: tuple[float, float]
) -> tuple[list[str], pikepdf.Stream | None, str | None]:
    """What's wrong with a page's image and content, the image, and its filter."""
    problems: list[str] = []
    xobjects = pdf_page.resources.get("/XObject", pikepdf.Dictionary())
    if len(xobjects) != 1:
        return [f"{len(xobjects)} XObjects, not one image"], None, None
    ((name, image),) = xobjects.items()
    if image.get("/Subtype") != pikepdf.Name.Image:
        return [f"XObject {name} is not an image"], None, None
    filters = image.get("/Filter")
    filter_ = str(filters) if isinstance(filters, pikepdf.Name) else None
    if filter_ not in ("/JBIG2Decode", "/CCITTFaxDecode"):
        problems.append(f"image filter {filters}, not one of JBIG2Decode or CCITTFaxDecode")
    if image.get("/BitsPerComponent") != 1 or image.get("/ColorSpace") != pikepdf.Name.DeviceGray:
        problems.append("the image is not 1-bit DeviceGray")
    decode = image.get("/Decode")
    if decode is not None and [float(v) for v in decode] != [0.0, 1.0]:
        problems.append(f"the image has a Decode array {list(decode)}")
    for key in ("/ImageMask", "/Mask", "/SMask"):
        if key in image and not (key == "/ImageMask" and image[key] is False):
            problems.append(f"the image has {key}")
    size = (int(image.get("/Width", 0)), int(image.get("/Height", 0)))
    if size != (width, height):
        problems.append(f"the image is {size[0]}x{size[1]}, the TIFF is {width}x{height}")
    if filter_ == "/JBIG2Decode":
        parms = image.get("/DecodeParms")
        if parms is not None and "/JBIG2Globals" in parms:
            problems.append("the image's DecodeParms has /JBIG2Globals")
        try:
            check_jbig2_generic(image.read_raw_bytes(), f"image {name}")
        except ArchivalError as exc:
            problems.append(str(exc))

    page_w, page_h = width * 72.0 / dpi[0], height * 72.0 / dpi[1]
    box = [float(v) for v in pdf_page.mediabox]
    expected_box = (0.0, 0.0, page_w, page_h)
    if len(box) != 4 or any(
        abs(a - b) > BOX_TOLERANCE_PT for a, b in zip(box, expected_box, strict=True)
    ):
        problems.append(
            f"MediaBox {box}, the TIFF at {dpi[0]:g}x{dpi[1]:g} ppi is {page_w:.4f}x{page_h:.4f}"
        )
    problems += _content_problems(pdf_page, str(name), (page_w, page_h))
    return problems, image, filter_


def _content_problems(pdf_page: pikepdf.Page, image_name: str, size: tuple[float, float]) -> list:
    problems: list[str] = []
    try:
        instructions = pikepdf.parse_content_stream(pdf_page)
    except pikepdf.PdfError as exc:
        return [f"content stream can't be parsed ({exc})"]
    draws = 0
    render_mode = 0
    matrix: list[float] | None = None
    for operands, operator in instructions:
        op = str(operator)
        if op not in _ALLOWED_OPERATORS:
            problems.append(f"the content stream uses the {op} operator")
        elif op == "cm":
            matrix = [float(v) for v in operands]
        elif op == "Do":
            draws += 1
            if str(operands[0]) != image_name:
                problems.append(f"draws {operands[0]}, not the page image")
            expected = [size[0], 0, 0, size[1], 0, 0]
            if matrix is None or any(
                abs(a - b) > BOX_TOLERANCE_PT for a, b in zip(matrix, expected, strict=True)
            ):
                problems.append(f"the image is drawn with matrix {matrix}, not the full page")
        elif op == "Tr":
            render_mode = int(operands[0])
        elif op == "Tj" and render_mode != 3:
            problems.append(f"text drawn in render mode {render_mode} (visible)")
    if draws != 1:
        problems.append(f"the page image is drawn {draws} times")
    return list(dict.fromkeys(problems))  # each kind of problem once per page


def _pdfimages_pages(poppler: Poppler, pdf_path: Path, out_dir: Path) -> dict[int, list[Path]]:
    """Every image poppler extracts, as PNG files, by 1-based page number."""
    poppler.run([poppler.pdfimages, "-png", "-p", str(pdf_path), str(out_dir / "img")])
    by_page: dict[int, list[Path]] = defaultdict(list)
    for path in sorted(out_dir.glob("img-*.png")):
        m = _PDFIMAGES_FILE.search(path.name)
        if m:
            by_page[int(m.group(1))].append(path)
    return by_page


def _pdftotext_pages(poppler: Poppler, pdf_path: Path, out_dir: Path) -> list[list]:
    """The words pdftotext extracts from each page, with their boxes."""
    out = out_dir / "words.html"
    poppler.run([poppler.pdftotext, "-bbox", str(pdf_path), str(out)])
    try:
        tree = etree.parse(str(out), _SAFE_XML)
    except etree.XMLSyntaxError as exc:
        raise ToolError(f"pdftotext -bbox wrote output that isn't XHTML ({exc})") from exc
    pages = []
    for page in tree.iter(f"{_XHTML}page"):
        pages.append(
            [
                ExtractedWord(
                    w.text or "",
                    float(w.get("xMin")),
                    float(w.get("yMin")),
                    float(w.get("xMax")),
                    float(w.get("yMax")),
                )
                for w in page.iter(f"{_XHTML}word")
            ]
        )
    return pages


def _alto_words(vt: VolumeTar, page: Page, dpi: tuple[float, float]) -> list[ExtractedWord]:
    if page.alto is None:
        return []
    alto = parse_alto(vt.read(page.alto), page.alto)
    words = []
    for w in alto.words:
        text = layer_text(w)
        if text:
            words.append(
                ExtractedWord(
                    text,
                    alto.to_points(w.hpos, dpi[0]),
                    alto.to_points(w.vpos, dpi[1]),
                    alto.to_points(w.hpos + w.width, dpi[0]),
                    alto.to_points(w.vpos + w.height, dpi[1]),
                )
            )
    return words


def _listed(counts: Mapping[str, int]) -> str:
    top = Counter(counts).most_common(_MAX_LISTED)
    more = len(counts) - len(top)
    return str(dict(top)) + (f" and {more} more" if more > 0 else "")


def _misplaced_message(result: PageText, tolerance: float) -> str:
    worst = max(result.misplaced, key=lambda m: -1.0 if m.deviation is None else m.deviation)
    where = f"{worst.text!r} at x {worst.x0:.1f}, y {worst.top:.1f}"
    if worst.deviation is None:
        how = "no ALTO word has that text"
    else:
        how = f"the nearest ALTO word with that text is {worst.deviation:.1f} pt away"
    return (
        f"{len(result.misplaced)} extracted words match no ALTO word within {tolerance:g} pt; "
        f"e.g. {where}: {how}"
    )


def _check_pages(
    pdf: pikepdf.Pdf,
    pdf_path: Path,
    vt: VolumeTar,
    pages: Sequence[Page],
    poppler: Poppler,
    tolerance: float,
) -> list[CheckResult]:
    streams: list[Failure] = []
    pixels: list[Failure] = []
    chars: list[Failure] = []
    positions: list[Failure] = []
    filters: Counter[str] = Counter()
    decoders: dict[str, str] = {}
    compared = characters = at_risk = dropped = 0
    placed: Counter[str] = Counter()
    worst = 0.0

    with tempfile.TemporaryDirectory(prefix="stare-verify-") as tmp:
        tmp_dir = Path(tmp)
        extracted = _pdftotext_pages(poppler, pdf_path, tmp_dir)
        if len(extracted) != len(pages):
            raise ToolError(
                f"pdftotext found {len(extracted)} pages in {pdf_path}, pikepdf {len(pages)}"
            )
        poppler_images: dict[int, list[Path]] | None = None

        for i, (pdf_page, page) in enumerate(zip(pdf.pages, pages, strict=True)):
            number = i + 1

            def fail(bucket: list[Failure], check: str, message: str, page=page, n=number):
                bucket.append(Failure(check, message, n, page.order, page.label))

            if page.tiff is None:
                fail(streams, "image_streams", "the METS lists no TIFF for this page")
                continue
            tiff_bytes = vt.read(page.tiff)
            info = read_tiff(tiff_bytes, page.tiff)
            problems, image, filter_ = _image_problems(pdf_page, info.width, info.height, info.dpi)
            for problem in problems:
                fail(streams, "image_streams", problem)
            if filter_:
                filters[filter_] += 1

            # pixels
            if image is None:
                fail(pixels, "image_pixels", "no single page image to compare")
            else:
                try:
                    if filter_ == "/JBIG2Decode":
                        if poppler_images is None:
                            poppler_images = _pdfimages_pages(poppler, pdf_path, tmp_dir)
                        found = poppler_images.get(number, [])
                        if len(found) != 1:
                            raise VerifyError(f"pdfimages extracted {len(found)} images")
                        decoders[filter_] = poppler.version
                        with Image.open(found[0]) as im:
                            decoded = im.copy()
                    else:
                        decoders[filter_ or str(image.get("/Filter"))] = "pikepdf"
                        decoded = pikepdf.PdfImage(image).as_pil_image()
                    with Image.open(io.BytesIO(tiff_bytes)) as src:
                        src.load()
                        problem = compare_bitonal(src, decoded)
                    compared += 1
                    if problem:
                        fail(pixels, "image_pixels", problem)
                except (ArchivalError, pikepdf.PdfError, OSError, ValueError) as exc:
                    fail(pixels, "image_pixels", f"the page image can't be decoded ({exc})")

            # text
            try:
                want = _alto_words(vt, page, info.dpi)
            except ArchivalError as exc:
                fail(chars, "text_chars", f"the ALTO can't be read ({exc})")
                continue
            result = compare_page_text(want, extracted[i], tolerance=tolerance)
            characters += result.characters
            at_risk += result.at_risk
            dropped += result.dropped
            placed.update({"exact": result.exact, "split": result.split, "merged": result.merged})
            placed["misplaced"] += len(result.misplaced)
            worst = max(worst, result.max_deviation)
            if not result.chars_ok:
                fail(
                    chars,
                    "text_chars",
                    f"characters differ from the ALTO: missing {_listed(result.missing)}, "
                    f"extra {_listed(result.extra)}",
                )
            if not result.positions_ok:
                fail(positions, "text_positions", _misplaced_message(result, tolerance))

    return [
        _result("image_streams", streams, {"filters": dict(filters)}),
        _result("image_pixels", pixels, {"pages_compared": compared, "decoders": decoders}),
        _result(
            "text_chars",
            chars,
            {
                "characters": characters,
                "characters_at_risk": at_risk,
                "characters_dropped": dropped,
                "ignored": "whitespace and hyphens, after NFKC",
            },
        ),
        _result(
            "text_positions",
            positions,
            {
                "words_extracted": sum(placed.values()),
                "words_exact": placed["exact"],
                "words_split": placed["split"],
                "words_merged": placed["merged"],
                "words_misplaced": placed["misplaced"],
                "tolerance_pt": tolerance,
                "max_deviation_pt": round(worst, 3),
            },
        ),
    ]


def verify_volume(
    pdf_path: str | os.PathLike[str],
    tar_path: str | os.PathLike[str],
    csv_path: str | os.PathLike[str] | None = None,
    *,
    sha256_path: str | os.PathLike[str] | None = None,
    poppler: Poppler | None = None,
    verapdf: VeraPdf | None = None,
    tolerance: float = DEFAULT_TOLERANCE_PT,
    env: Mapping[str, str] | None = None,
) -> VerifyReport:
    """Verify `pdf_path` against the volume tar it was built from; see the module docstring
    for the checks.

    `csv_path` defaults to `<tar>.csv`. `sha256_path` is the recorded SHA-256 of the tar; it
    defaults to `<tar>.sha256` when that exists (the mirror's layout), and a path given
    explicitly must exist. `poppler` defaults to the one on PATH (`env`'s PATH when given);
    without it this raises ToolError. PDF/A validation runs only when `verapdf` is given.
    """
    pdf_path, tar_path = Path(pdf_path), Path(tar_path)
    poppler = poppler or Poppler.locate(env)
    if poppler is None:
        raise ToolError("verification needs poppler's pdfimages and pdftotext on PATH")
    if sha256_path is None:
        default = tar_path.with_name(tar_path.name + ".sha256")
        sha256_file_path = default if default.exists() else None
    else:
        sha256_file_path = Path(sha256_path)
        if not sha256_file_path.is_file():
            raise VerifyError(f"{sha256_file_path}: no such sha256 file")

    try:
        output_size = pdf_path.stat().st_size
        output_sha256 = sha256_file(pdf_path)
        pdf = pikepdf.open(pdf_path)
    except (OSError, pikepdf.PdfError) as exc:
        raise VerifyError(f"{pdf_path}: not a readable PDF ({exc})") from exc

    tools = poppler.tool_versions()
    with pdf, VolumeTar.open(tar_path, csv_path) as vt:
        volume = load_volume(vt)
        pages = volume.mets.pages
        xmp = _read_xmp(pdf)
        computed = sha256_file(tar_path)
        source, recorded = _check_source(tar_path, sha256_file_path, xmp.source_sha256, computed)
        structure = _check_structure(pdf, pages)
        checks = [source, structure, _check_no_jbig2_globals(pdf)]
        if len(pdf.pages) == len(pages):
            checks += _check_pages(pdf, pdf_path, vt, pages, poppler, tolerance)
        else:
            reason = {"reason": "the page count doesn't match the METS"}
            checks += [CheckResult(name, "skipped", reason) for name in PAGE_CHECKS]
        labels = tuple(p.label for p in pdf.pages)
        page_count = len(pdf.pages)

    if verapdf is None:
        checks.append(CheckResult("pdfa", "skipped", {"reason": "not requested"}))
    else:
        tools.update(verapdf.tool_versions())
        passed, output = verapdf.validate(pdf_path)
        detail = {"flavour": "3b", "validator": verapdf.version}
        failures = () if passed else (Failure("pdfa", output[-2000:]),)
        checks.append(_result("pdfa", failures, detail))

    return VerifyReport(
        pdf_path=pdf_path,
        tar_path=tar_path,
        volume_id=xmp.volume_id,
        barcode=xmp.barcode,
        page_count=page_count,
        labels=labels,
        output_sha256=output_sha256,
        output_size=output_size,
        source_sha256=computed,
        recorded_source_sha256=recorded,
        embedded_source_sha256=xmp.source_sha256,
        encoder=xmp.encoder,
        encoder_settings=xmp.encoder_settings,
        checks=tuple(checks),
        tools=tools,
    )
