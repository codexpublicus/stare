"""The invisible text layer: one run per ALTO word, in a glyphless font, over the page image.

Each word is drawn in render mode 3 (invisible) with an embedded TrueType font whose only
glyph is empty and 0.5 em wide. Text is written as UTF-16 code units through Identity-H, and
the ToUnicode map is the identity, so a reader extracts exactly the ALTO CONTENT. The font size
is the word box's height and horizontal scaling (Tz) stretches the run to the box's width, so
selection and search highlight the word on the scan. Characters outside the BMP are dropped
(the code units are the CIDs, and the CID font covers 0000 to FFFF).
"""

from __future__ import annotations

import io
from functools import cache

import pikepdf
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from pikepdf import Array, Dictionary, Name, String

from stare_archival.alto import AltoPage

FONT_RESOURCE = "/F0"
GLYPH_WIDTH = 0.5  # em
BASELINE = 0.85  # of the box height, down from its top
# fontTools timestamps count seconds from 1904-01-01; pinned so builds are reproducible
_FONT_TIMESTAMP = 3_786_912_000  # 2024-01-01T00:00:00Z

_TO_UNICODE = (
    b"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
    b"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
    b"/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
    b"1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
    b"1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n"
    b"endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
)


@cache
def glyphless_font_program() -> bytes:
    """A TrueType font with one empty, 500-unit-wide glyph (plus .notdef)."""
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "g1"])
    fb.setupCharacterMap({0x20: "g1"})
    empty = TTGlyphPen(None).glyph()
    fb.setupGlyf({".notdef": empty, "g1": empty})
    fb.setupHorizontalMetrics({".notdef": (500, 0), "g1": (500, 0)})
    fb.setupHorizontalHeader(ascent=1000, descent=0)
    fb.setupNameTable({"familyName": "GlyphLess", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=1000, usWinAscent=1000, usWinDescent=0)
    fb.setupPost()
    fb.font["head"].created = _FONT_TIMESTAMP
    fb.font["head"].modified = _FONT_TIMESTAMP
    fb.font.recalcTimestamp = False
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def add_glyphless_font(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """Add the glyphless Type0 font (CIDFontType2, Identity-H, identity ToUnicode) to `pdf`
    and return it as an indirect object, to be shared by every page."""
    program = glyphless_font_program()
    font_file = pikepdf.Stream(pdf, program)
    font_file.Length1 = len(program)
    descriptor = pdf.make_indirect(
        Dictionary(
            Type=Name.FontDescriptor,
            FontName=Name("/GlyphLess"),
            Flags=4,
            FontBBox=Array([0, 0, 500, 1000]),
            ItalicAngle=0,
            Ascent=1000,
            Descent=0,
            CapHeight=1000,
            StemV=80,
            FontFile2=pdf.make_indirect(font_file),
        )
    )
    # every CID (a UTF-16 code unit) draws glyph 1
    cid_to_gid = pdf.make_indirect(pikepdf.Stream(pdf, b"\x00\x01" * 65536))
    cid_font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.CIDFontType2,
            BaseFont=Name("/GlyphLess"),
            CIDSystemInfo=Dictionary(
                Registry=String("Adobe"), Ordering=String("Identity"), Supplement=0
            ),
            FontDescriptor=descriptor,
            DW=500,
            CIDToGIDMap=cid_to_gid,
        )
    )
    return pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type0,
            BaseFont=Name("/GlyphLess"),
            Encoding=Name("/Identity-H"),
            DescendantFonts=Array([cid_font]),
            ToUnicode=pdf.make_indirect(pikepdf.Stream(pdf, _TO_UNICODE)),
        )
    )


def text_operators(page: AltoPage, *, page_height: float, dpi: tuple[float, float]) -> bytes:
    """Content stream operators for the page's words; empty when it has none.

    `page_height` is the PDF page height in points; `dpi` the scan's (x, y) resolution, used
    only when the ALTO is in pixels. ALTO boxes have a top-left origin; PDF's is bottom-left.
    """
    runs = []
    for word in page.words:
        x = page.to_points(word.hpos, dpi[0])
        width = page.to_points(word.width, dpi[0])
        top = page.to_points(word.vpos, dpi[1])
        size = page.to_points(word.height, dpi[1])
        if width <= 0 or size <= 0:
            continue
        text = "".join(ch for ch in word.content if ord(ch) < 0x10000)
        if not text:
            continue
        encoded = text.encode("utf-16-be")
        scale = 100.0 * width / (len(encoded) // 2 * GLYPH_WIDTH * size)
        baseline = page_height - top - BASELINE * size
        runs.append(
            b"%s %.2f Tf %.2f Tz 1 0 0 1 %.2f %.2f Tm <%s> Tj\n"
            % (FONT_RESOURCE.encode(), size, scale, x, baseline, encoded.hex().encode())
        )
    if not runs:
        return b""
    return b"BT\n3 Tr\n" + b"".join(runs) + b"ET\n"
