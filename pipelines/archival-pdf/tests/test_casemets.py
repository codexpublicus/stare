import pytest
from fixture_paths import CASEMETS, ROOT

from stare_archival.casemets import Case, parse_casemets
from stare_archival.errors import MetadataError
from stare_archival.tarindex import VolumeTar


@pytest.fixture
def cases(tar_path):
    with VolumeTar.open(tar_path) as vt:
        return {n: parse_casemets(vt.read(path)) for n, path in CASEMETS.items()}


def test_published_case(cases):
    assert cases[202] == Case(
        case_id="32044109578831_0202",
        name="Adolph B. BONDY, Appellant, v. Constantino PAPPAS, Appellee",
        name_abbreviation="Bondy v. Pappas",
        citation="152 A.2d 839",
        first_page="839",
        last_page="840",
        duplicative=False,
        page_orders=(871, 872),
        tiff_file_ids=("tiff_00436_0", "tiff_00436_1"),
    )


def test_duplicative_case_has_range_but_no_name(cases):
    dup = cases[203]
    assert dup.duplicative is True
    assert dup.case_id is None
    assert dup.name is None and dup.name_abbreviation is None and dup.citation is None
    assert (dup.first_page, dup.last_page) == ("841", "847")
    assert dup.page_orders == tuple(range(873, 880))
    assert dup.tiff_file_ids[0] == "tiff_00437_0"


def test_case_ending_on_first_fixture_page(cases):
    assert cases[201].duplicative is True
    assert cases[201].page_orders[-1] == 870
    assert (cases[201].first_page, cases[201].last_page) == ("833", "838")


def test_parse_casemets_accepts_uncompressed_xml(tar_path):
    with VolumeTar.open(tar_path) as vt:
        raw = vt.read_decoded(CASEMETS[202])
    assert parse_casemets(raw).citation == "152 A.2d 839"


@pytest.mark.parametrize(
    ("xml", "needle"),
    [
        (b"<mets", "CASEMETS"),
        (b'<mets xmlns="http://www.loc.gov/METS/"><structMap TYPE="physical"/></mets>', "casebody"),
        (
            b'<mets xmlns="http://www.loc.gov/METS/"><fileSec><fileGrp USE="casebody"><file>'
            b"<FContent><xmlData><casebody "
            b'xmlns="http://nrs.harvard.edu/urn-3:HLS.Libr.US_Case_Law.Schema.Case_Body:v1" '
            b'firstpage="1" lastpage="2"/></xmlData></FContent></file></fileGrp></fileSec>'
            b'<structMap TYPE="physical"><div TYPE="volume"><div TYPE="page" ORDER="q">'
            b"</div></div></structMap></mets>",
            "ORDER",
        ),
    ],
)
def test_parse_casemets_rejects_malformed(xml, needle):
    with pytest.raises(MetadataError, match=needle):
        parse_casemets(xml, path=f"{ROOT}/casemets/x.xml.gz")
