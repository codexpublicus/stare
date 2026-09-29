import gzip

import pytest
from fixture_paths import CASEMETS, METS, ROOT

from stare_archival.errors import MetadataError
from stare_archival.mets import CaseRef, Page, parse_mets
from stare_archival.tarindex import VolumeTar, gunzip_member


@pytest.fixture
def fixture_mets(tar_path):
    with VolumeTar.open(tar_path) as vt:
        return parse_mets(vt.read(METS), METS)


def test_fixture_mets_pages_in_order_with_labels(fixture_mets):
    assert [p.order for p in fixture_mets.pages] == [870, 871, 872, 873]
    assert [p.label for p in fixture_mets.pages] == ["838", "839", "840", "841"]


def test_fixture_mets_maps_pages_to_tar_members(fixture_mets):
    page = fixture_mets.pages[1]
    assert page == Page(
        order=871,
        label="839",
        tiff=f"{ROOT}/images/32044109578831_00436_0.tif",
        jpg=f"{ROOT}/images/32044109578831_00436_0.jpg",
        alto=f"{ROOT}/alto/{ROOT}_ALTO_00436_0.xml.gz",
        file_ids={"tiff": "tiff_00436_0", "jpg": "jpg_00436_0", "alto": "alto_00436_0"},
    )


def test_fixture_mets_cases_in_logical_order(fixture_mets):
    assert fixture_mets.cases == (
        CaseRef(order=201, file_id="casemets_0201", path=CASEMETS[201]),
        CaseRef(order=202, file_id="casemets_0202", path=CASEMETS[202]),
        CaseRef(order=203, file_id="casemets_0203", path=CASEMETS[203]),
    )


def test_fixture_mets_volume_metadata(fixture_mets):
    assert fixture_mets.barcode == "32044109578831"
    assert fixture_mets.reporter == "A.2d"
    assert fixture_mets.volume_number == "152"


def test_page_lookup_by_file_id(fixture_mets):
    assert fixture_mets.page_for_file_id("tiff_00437_0").order == 873
    assert fixture_mets.page_for_file_id("alto_00436_1").order == 872
    with pytest.raises(KeyError):
        fixture_mets.page_for_file_id("tiff_99999_0")


def test_full_source_mets(source_mets_bytes):
    mets = parse_mets(source_mets_bytes, METS)
    assert len(mets.pages) == 1056
    assert [p.order for p in mets.pages] == list(range(1, 1057))
    assert [p.label for p in mets.pages[:3]] == ["I", "II", "III"]
    assert all(p.tiff and p.alto and p.jpg for p in mets.pages)
    assert len(mets.cases) == 225
    assert mets.cases[0].path == f"{ROOT}/casemets/{ROOT}_CASEMETS_0001.xml.gz"


def test_parse_mets_accepts_uncompressed_xml(source_mets_bytes):
    raw = gunzip_member(source_mets_bytes, "METS.xml.gz")
    assert len(parse_mets(raw, METS).pages) == 1056


METS_HEAD = (
    '<mets xmlns="http://www.loc.gov/METS/" xmlns:xlink="http://www.w3.org/1999/xlink">'
    '<fileSec><fileGrp USE="tiff"><file ID="tiff_1"><FLocat xlink:href="images/1.tif"/></file>'
    "</fileGrp></fileSec>"
)


@pytest.mark.parametrize(
    ("xml", "needle"),
    [
        (b"not xml at all", "METS"),
        (gzip.compress(b"<mets"), "METS"),
        (b'<mets xmlns="http://www.loc.gov/METS/"/>', "physical"),
        (
            METS_HEAD
            + '<structMap TYPE="physical"><div TYPE="page" ORDER="1">'
            + '<fptr FILEID="tiff_2"/></div></structMap></mets>',
            "tiff_2",
        ),
        (
            METS_HEAD
            + '<structMap TYPE="physical"><div TYPE="page">'
            + '<fptr FILEID="tiff_1"/></div></structMap></mets>',
            "ORDER",
        ),
        (
            METS_HEAD
            + '<structMap TYPE="physical"><div TYPE="page" ORDER="x">'
            + '<fptr FILEID="tiff_1"/></div></structMap></mets>',
            "ORDER",
        ),
    ],
)
def test_parse_mets_rejects_malformed(xml, needle):
    if isinstance(xml, str):
        xml = xml.encode()
    with pytest.raises(MetadataError, match=needle):
        parse_mets(xml, METS)


def test_parse_mets_rejects_duplicate_page_order():
    xml = (
        METS_HEAD
        + '<structMap TYPE="physical"><div TYPE="page" ORDER="1"><fptr FILEID="tiff_1"/></div>'
        + '<div TYPE="page" ORDER="1"><fptr FILEID="tiff_1"/></div></structMap></mets>'
    ).encode()
    with pytest.raises(MetadataError, match="duplicate"):
        parse_mets(xml, METS)
