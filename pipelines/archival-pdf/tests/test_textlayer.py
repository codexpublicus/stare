import io
import re

import pikepdf
import pytest
from fixture_paths import ALTO_EMPTY, ALTO_TEXT, FIXTURES
from fontTools.ttLib import TTFont

from stare_archival.alto import AltoPage, Line, Word, parse_alto
from stare_archival.tarindex import VolumeTar
from stare_archival.textlayer import add_glyphless_font, glyphless_font_program, text_operators

TJ = re.compile(rb"/F0 ([\d.]+) Tf ([\d.]+) Tz 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm <([0-9a-f]*)> Tj")


@pytest.fixture(scope="module")
def alto_text() -> AltoPage:
    with VolumeTar.open(FIXTURES / "152.tar") as vt:
        return parse_alto(vt.read(ALTO_TEXT), ALTO_TEXT)


def test_font_program_is_deterministic_and_glyphless():
    first = glyphless_font_program()
    assert first == glyphless_font_program()
    font = TTFont(io.BytesIO(first))
    assert font.getGlyphOrder() == [".notdef", "g1"]
    assert font["hmtx"]["g1"] == (500, 0)
    assert font["glyf"]["g1"].numberOfContours == 0
    # fixed timestamps: the font can't make two builds of one volume differ
    assert font["head"].created == font["head"].modified


def test_add_glyphless_font_builds_an_embedded_type0_font():
    pdf = pikepdf.new()
    font = add_glyphless_font(pdf)
    assert font.Subtype == pikepdf.Name.Type0
    assert font.Encoding == pikepdf.Name("/Identity-H")
    assert b"beginbfrange" in font.ToUnicode.read_bytes()
    cid = font.DescendantFonts[0]
    assert cid.Subtype == pikepdf.Name.CIDFontType2
    assert cid.DW == 500
    assert cid.FontDescriptor.FontFile2.read_bytes() == glyphless_font_program()
    assert cid.CIDToGIDMap.read_bytes() == b"\x00\x01" * 65536


def test_text_operators_write_one_invisible_run_per_word(alto_text):
    ops = text_operators(alto_text, page_height=792.0, dpi=(300.0, 300.0))
    assert ops.startswith(b"BT\n3 Tr\n")
    assert ops.endswith(b"ET\n")
    runs = TJ.findall(ops)
    assert len(runs) == len(alto_text.words) == 302
    decoded = [bytes.fromhex(r[4].decode()).decode("utf-16-be") for r in runs]
    assert decoded == [w.content for w in alto_text.words]


def test_text_operators_place_words_in_points(alto_text):
    word = alto_text.words[0]
    ops = text_operators(alto_text, page_height=792.0, dpi=(300.0, 300.0))
    size, tz, x, y, hexed = TJ.search(ops).groups()
    height_pt = word.height * 72 / 300
    width_pt = word.width * 72 / 300
    assert float(size) == pytest.approx(height_pt, abs=0.01)
    assert float(x) == pytest.approx(word.hpos * 72 / 300, abs=0.01)
    # baseline at 85% of the box height from its top, in PDF's bottom-left origin
    top = 792.0 - word.vpos * 72 / 300
    assert float(y) == pytest.approx(top - 0.85 * height_pt, abs=0.01)
    # every glyph is 0.5 em wide, so Tz stretches the run to the box width
    n = len(word.content)
    assert n * 0.5 * float(size) * float(tz) / 100 == pytest.approx(width_pt, rel=0.01)


def test_text_operators_convert_absolute_units():
    word = Word("Law", hpos=254.0, vpos=508.0, width=127.0, height=50.8)
    page = AltoPage(
        unit="mm10",
        width=2159.0,
        height=2794.0,
        lines=(Line(254.0, 508.0, 127.0, 50.8, (word,)),),
    )
    # mm10 is absolute: the dpi doesn't matter
    ops = text_operators(page, page_height=792.0, dpi=(600.0, 600.0))
    size, _tz, x, y, _ = TJ.search(ops).groups()
    assert float(x) == pytest.approx(72.0)
    assert float(size) == pytest.approx(14.4)
    assert float(y) == pytest.approx(792.0 - 144.0 - 0.85 * 14.4, abs=0.01)


def test_text_operators_skip_empty_boxes_and_astral_characters():
    words = (
        Word("a", 0, 0, 0, 10),  # zero width
        Word("\U0001f600", 0, 0, 10, 10),  # nothing left after dropping non-BMP
        Word("ok\U0001f600", 0, 0, 10, 10),
    )
    page = AltoPage(unit="pixel", width=100, height=100, lines=(Line(0, 0, 10, 10, words),))
    runs = TJ.findall(text_operators(page, page_height=24.0, dpi=(300.0, 300.0)))
    assert [bytes.fromhex(r[4].decode()).decode("utf-16-be") for r in runs] == ["ok"]


def test_text_operators_of_a_page_without_words_is_empty():
    with VolumeTar.open(FIXTURES / "152.tar") as vt:
        page = parse_alto(vt.read(ALTO_EMPTY), ALTO_EMPTY)
    assert text_operators(page, page_height=792.0, dpi=(300.0, 300.0)) == b""
