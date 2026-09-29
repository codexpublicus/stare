import gzip

import pytest
from fixture_paths import ALTO_EMPTY, ALTO_TEXT

from stare_archival.alto import Word, parse_alto, to_points
from stare_archival.errors import MetadataError
from stare_archival.tarindex import VolumeTar


@pytest.fixture
def text_page(tar_path):
    with VolumeTar.open(tar_path) as vt:
        return parse_alto(vt.read(ALTO_TEXT), ALTO_TEXT)


def test_text_page_dimensions_and_unit(text_page):
    assert text_page.unit == "pixel"
    assert (text_page.width, text_page.height) == (1848.0, 2997.0)


def test_text_page_lines_and_words(text_page):
    assert len(text_page.lines) == 50
    assert len(text_page.words) == 302
    assert sum(len(line.words) for line in text_page.lines) == 302
    first = text_page.lines[0]
    assert (first.hpos, first.vpos, first.width, first.height) == (1547.0, 192.0, 72.0, 36.0)
    assert first.words == (Word("839", 1547.0, 192.0, 72.0, 36.0),)
    assert [w.content for w in text_page.lines[1].words] == [
        "Adolph",
        "B.",
        "BONDY,",
        "Appellant,",
    ]


def test_text_page_transform(text_page):
    assert text_page.transform == pytest.approx(
        (0.999995500003375, -0.002999995500002025, 0.002999995500002025, 0.999995500003375,
         0.4880000000000564, -5.26000000000001)
    )  # fmt: skip


def test_empty_duplicative_page(tar_path):
    with VolumeTar.open(tar_path) as vt:
        page = parse_alto(vt.read(ALTO_EMPTY), ALTO_EMPTY)
    assert (page.width, page.height) == (1853.0, 3000.0)
    assert page.lines == ()
    assert page.words == ()


def test_parse_alto_accepts_uncompressed_xml(tar_path):
    with VolumeTar.open(tar_path) as vt:
        raw = vt.read_decoded(ALTO_TEXT)
    assert len(parse_alto(raw).words) == 302


# --- units ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "unit", "dpi", "points"),
    [
        (300, "pixel", 300, 72.0),
        (600, "pixel", 400, 108.0),
        (254, "mm10", None, 72.0),
        (1200, "inch1200", None, 72.0),
        (2400, "inch1200", 300, 144.0),  # dpi is irrelevant for absolute units
    ],
)
def test_to_points(value, unit, dpi, points):
    assert to_points(value, unit, dpi) == pytest.approx(points)


def test_to_points_pixel_needs_dpi():
    with pytest.raises(ValueError, match="dpi"):
        to_points(10, "pixel")
    with pytest.raises(ValueError, match="dpi"):
        to_points(10, "pixel", 0)


def test_to_points_unknown_unit():
    with pytest.raises(MetadataError, match="furlong"):
        to_points(10, "furlong", 300)


def test_page_to_points_uses_its_unit(text_page):
    assert text_page.to_points(300, dpi=300) == pytest.approx(72.0)


# --- synthetic ALTO: other versions, units, hyphenation ---------------------

ALTO_V2_MM10 = b"""<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v2#">
  <Description><MeasurementUnit>mm10</MeasurementUnit></Description>
  <Layout><Page WIDTH="2159" HEIGHT="2794" ID="P1"><PrintSpace>
    <TextBlock><TextLine HPOS="100" VPOS="200" WIDTH="500" HEIGHT="40">
      <String CONTENT="inter-" HPOS="100" VPOS="200" WIDTH="240" HEIGHT="40"
              SUBS_TYPE="HypPart1" SUBS_CONTENT="international"/>
      <HYP CONTENT="-"/>
    </TextLine>
    <TextLine HPOS="100" VPOS="260" WIDTH="300" HEIGHT="40">
      <String CONTENT="national" HPOS="100" VPOS="260" WIDTH="300" HEIGHT="40"
              SUBS_TYPE="HypPart2" SUBS_CONTENT="international"/>
      <SP/>
      <String CONTENT="" HPOS="420" VPOS="260" WIDTH="10" HEIGHT="40"/>
    </TextLine></TextBlock>
  </PrintSpace></Page></Layout>
</alto>
"""


def test_alto_v2_mm10_with_hyphenation_kept_as_is():
    page = parse_alto(gzip.compress(ALTO_V2_MM10), "synthetic.xml.gz")
    assert page.unit == "mm10"
    assert page.transform is None
    assert [w.content for w in page.words] == ["inter-", "national"]
    assert page.words[0].subs_type == "HypPart1"
    assert page.words[0].subs_content == "international"
    assert page.words[1].subs_content == "international"
    assert page.to_points(254) == pytest.approx(72.0)


def test_alto_without_namespace_or_unit_defaults_to_pixel():
    xml = (
        b'<alto><Layout><Page WIDTH="10" HEIGHT="20"><TextLine HPOS="1" VPOS="2" WIDTH="3" '
        b'HEIGHT="4"><String CONTENT="x" HPOS="1" VPOS="2" WIDTH="3" HEIGHT="4"/></TextLine>'
        b"</Page></Layout></alto>"
    )
    page = parse_alto(xml)
    assert page.unit == "pixel"
    assert page.words == (Word("x", 1.0, 2.0, 3.0, 4.0),)


@pytest.mark.parametrize(
    ("xml", "needle"),
    [
        (b"<alto", "ALTO"),
        (b"<alto><Layout/></alto>", "Page"),
        (b'<alto><Layout><Page WIDTH="10"/></Layout></alto>', "HEIGHT"),
        (
            b'<alto><Layout><Page WIDTH="10" HEIGHT="20"><TextLine HPOS="1" VPOS="2" WIDTH="3" '
            b'HEIGHT="4"><String CONTENT="x" '
            b'VPOS="2" WIDTH="3" HEIGHT="4"/></TextLine></Page></Layout></alto>',
            "HPOS",
        ),
        (
            b'<alto><Layout><Page WIDTH="10" HEIGHT="20"><TextLine HPOS="1" VPOS="2" WIDTH="3" '
            b'HEIGHT="4"><String CONTENT="x" '
            b'HPOS="a" VPOS="2" WIDTH="3" HEIGHT="4"/></TextLine></Page></Layout></alto>',
            "HPOS",
        ),
        (
            b"<alto><Description><MeasurementUnit>furlong</MeasurementUnit></Description>"
            b'<Layout><Page WIDTH="10" HEIGHT="20"/></Layout></alto>',
            "furlong",
        ),
    ],
)
def test_parse_alto_rejects_malformed(xml, needle):
    with pytest.raises(MetadataError, match=needle):
        parse_alto(xml, "bad.xml")
