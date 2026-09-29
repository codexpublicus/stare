import hashlib
import io
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pikepdf
import pytest
from fixture_paths import CASEMETS, FIXTURES, METS, ROOT
from lxml import etree
from PIL import Image
from tools import require, verapdf_command

from stare_archival import __version__
from stare_archival.alto import parse_alto
from stare_archival.build import BuildResult, bookmark_title, build_volume
from stare_archival.casemets import Case
from stare_archival.encoders import G4Encoder
from stare_archival.tarindex import VolumeTar
from stare_archival.volume import load_volume

CREATED = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)
VOLUME_ID = "a2d/152"
LABELS = ["838", "839", "840", "841"]
BOOKMARKS = [
    ("Case 201 (pp. 833-838, duplicative)", 0),  # starts before the slice: first page present
    ("Bondy v. Pappas, 152 A.2d 839", 1),
    ("Case 203 (pp. 841-847, duplicative)", 3),
]
NS = {
    "x": "adobe:ns:meta/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "xmp": "http://ns.adobe.com/xap/1.0/",
    "pdf": "http://ns.adobe.com/pdf/1.3/",
    "pdfaid": "http://www.aiim.org/pdfa/ns/id/",
    "stare": "https://stare.pub/ns/archival/1.0/",
    "pdfaExtension": "http://www.aiim.org/pdfa/ns/extension/",
    "pdfaSchema": "http://www.aiim.org/pdfa/ns/schema#",
    "pdfaProperty": "http://www.aiim.org/pdfa/ns/property#",
}
TJ_HEX = re.compile(rb"<([0-9a-f]*)> Tj")


def _build(tar_path, csv_path, out: Path, encoder=None, **kw) -> BuildResult:
    kw.setdefault("volume_id", VOLUME_ID)
    kw.setdefault("created", CREATED)
    return build_volume(tar_path, csv_path, out, encoder or G4Encoder(), **kw)


@pytest.fixture(scope="module")
def built(tmp_path_factory) -> tuple[BuildResult, Path]:
    out = tmp_path_factory.mktemp("g4") / "152.pdf"
    result = _build(FIXTURES / "152.tar", FIXTURES / "152.tar.csv", out)
    return result, out


@pytest.fixture
def pdf(built):
    with pikepdf.open(built[1]) as doc:
        yield doc


@pytest.fixture(scope="module")
def volume():
    with VolumeTar.open(FIXTURES / "152.tar") as vt:
        yield vt, load_volume(vt)


def _member_bytes(path: str) -> bytes:
    with VolumeTar.open(FIXTURES / "152.tar") as vt:
        return vt.read(path)


def test_build_result_describes_the_output(built, tar_path):
    result, out = built
    assert result.out_path == out
    assert result.volume_id == VOLUME_ID
    assert result.page_count == 4
    assert result.bookmark_count == 3
    assert result.pages_without_text == 2
    assert result.output_size == out.stat().st_size
    assert result.output_sha256 == hashlib.sha256(out.read_bytes()).hexdigest()
    assert result.source_sha256 == hashlib.sha256(tar_path.read_bytes()).hexdigest()
    assert 0 < result.image_bytes < result.output_size
    assert result.encoder == G4Encoder().name
    assert result.encoder_settings == G4Encoder().settings
    assert set(result.attachments) == {
        p.removeprefix(ROOT + "/") for p in (METS, *CASEMETS.values())
    }


def test_no_temporary_file_is_left_behind(built):
    out = built[1]
    assert sorted(p.name for p in out.parent.iterdir()) == ["152.pdf"]


def test_pages_are_sized_from_the_tiff_at_its_resolution(pdf, volume):
    vt, vol = volume
    assert len(pdf.pages) == 4
    for page, meta in zip(pdf.pages, vol.mets.pages, strict=True):
        with Image.open(io.BytesIO(vt.read(meta.tiff))) as im:
            w, h = im.size
        box = [float(v) for v in page.MediaBox]
        assert box == pytest.approx([0, 0, w * 72 / 300, h * 72 / 300], abs=0.001)


def test_each_page_has_one_lossless_bitonal_image(pdf):
    for page in pdf.pages:
        images = list(page.Resources.XObject.values())
        assert len(images) == 1
        img = images[0]
        assert img.BitsPerComponent == 1
        assert img.ColorSpace == pikepdf.Name.DeviceGray
        assert img.Filter == pikepdf.Name.CCITTFaxDecode
        assert "/JBIG2Globals" not in img.get("/DecodeParms", {})


def test_images_decode_to_the_tiff_pixels(pdf, volume):
    vt, vol = volume
    for page, meta in zip(pdf.pages, vol.mets.pages, strict=True):
        img = pikepdf.PdfImage(page.Resources.XObject.Im0).as_pil_image()
        with Image.open(io.BytesIO(vt.read(meta.tiff))) as src:
            assert img.convert("1").tobytes() == src.convert("1").tobytes(), meta.tiff


def test_page_labels_come_from_mets(pdf):
    assert [p.label for p in pdf.pages] == LABELS


def test_bookmarks_point_at_each_cases_first_present_page(pdf):
    with pdf.open_outline() as outline:
        got = []
        for item in outline.root:
            dest = item.destination
            got.append((item.title, pikepdf.Page(dest[0]).index))
    assert got == BOOKMARKS


def test_volume_metadata_is_attached_as_source_files(pdf):
    expected = {p.removeprefix(ROOT + "/"): p for p in (METS, *CASEMETS.values())}
    assert set(pdf.attachments) == set(expected)
    af = list(pdf.Root.AF)
    assert len(af) == len(expected)
    for name, spec in pdf.attachments.items():
        assert spec.obj.AFRelationship == pikepdf.Name.Source
        assert name == spec.obj.UF
        ef = spec.obj.EF.F
        assert ef.read_bytes() == _member_bytes(expected[name])
        assert ef.Subtype == pikepdf.Name("/application/gzip")
        assert ef.Params.Size == len(ef.read_bytes())
        assert str(ef.Params.ModDate) == "D:20260929120000Z"
    # the per-page ALTO stays in the tar ("lean")
    assert not any("alto" in name.lower() for name in pdf.attachments)


def test_text_layer_holds_the_alto_words_in_order(pdf, volume):
    vt, vol = volume
    for page, meta in zip(pdf.pages, vol.mets.pages, strict=True):
        alto = parse_alto(vt.read(meta.alto), meta.alto)
        content = page.Contents.read_bytes()
        words = [bytes.fromhex(h.decode()).decode("utf-16-be") for h in TJ_HEX.findall(content)]
        assert words == [w.content for w in alto.words]
        if words:
            assert b"3 Tr" in content
            assert "/F0" in page.Resources.Font


@pytest.mark.poppler
def test_text_layer_is_extractable_by_a_reader(built, volume):
    pdftotext = require("pdftotext")
    vt, vol = volume
    page = vol.mets.pages[1]
    alto = parse_alto(vt.read(page.alto), page.alto)
    out = subprocess.run(
        [pdftotext, "-f", "2", "-l", "2", "-raw", str(built[1]), "-"],
        capture_output=True,
        check=True,
    ).stdout.decode()
    assert out.split() == [w.content for w in alto.words]


def test_pdfa_output_intent_and_catalog(pdf):
    (intent,) = list(pdf.Root.OutputIntents)
    assert intent.S == pikepdf.Name.GTS_PDFA1
    assert intent.DestOutputProfile.N == 3
    assert pdf.pdf_version >= "1.7"
    assert len(pdf.trailer.ID) == 2


def _xmp(pdf) -> etree._Element:
    return etree.fromstring(pdf.Root.Metadata.read_bytes())


def _text(tree, xpath: str) -> str:
    (value,) = tree.xpath(xpath, namespaces=NS)
    return value if isinstance(value, str) else value.text


def test_xmp_identifies_pdfa3b_source_and_encoder(pdf, built):
    tree = _xmp(pdf)
    d = "//rdf:Description"
    assert _text(tree, f"{d}/pdfaid:part") == "3"
    assert _text(tree, f"{d}/pdfaid:conformance") == "B"
    assert _text(tree, f"{d}/dc:title/rdf:Alt/rdf:li") == "152 A.2d"
    assert _text(tree, f"{d}/dc:source") == VOLUME_ID
    assert _text(tree, f"{d}/xmp:CreateDate") == "2026-09-29T12:00:00Z"
    assert _text(tree, f"{d}/xmp:ModifyDate") == "2026-09-29T12:00:00Z"
    assert _text(tree, f"{d}/xmp:MetadataDate") == "2026-09-29T12:00:00Z"
    assert _text(tree, f"{d}/xmp:CreatorTool") == f"stare-archival {__version__}"
    assert _text(tree, f"{d}/stare:sourceSha256") == built[0].source_sha256
    assert _text(tree, f"{d}/stare:barcode") == "32044109578831"
    assert _text(tree, f"{d}/stare:imageEncoder") == G4Encoder().name
    assert _text(tree, f"{d}/stare:imageEncoderSettings") == G4Encoder().settings
    # custom properties must be declared in a PDF/A extension schema
    declared = tree.xpath("//pdfaExtension:schemas//pdfaProperty:name/text()", namespaces=NS)
    assert set(declared) >= {"sourceSha256", "barcode", "imageEncoder", "imageEncoderSettings"}


def test_docinfo_matches_xmp(pdf):
    assert str(pdf.docinfo.Title) == "152 A.2d"
    assert str(pdf.docinfo.CreationDate) == "D:20260929120000Z"
    assert str(pdf.docinfo.ModDate) == "D:20260929120000Z"
    tree = _xmp(pdf)
    assert _text(tree, "//rdf:Description/pdf:Producer") == str(pdf.docinfo.Producer)


def test_output_is_deterministic(built, tar_path, csv_path, tmp_path):
    again = _build(tar_path, csv_path, tmp_path / "again.pdf")
    assert again.output_sha256 == built[0].output_sha256
    assert (tmp_path / "again.pdf").read_bytes() == built[1].read_bytes()


def test_source_sha256_parameter_is_recorded_as_given(tar_path, csv_path, tmp_path):
    given = "ab" * 32
    result = _build(tar_path, csv_path, tmp_path / "x.pdf", source_sha256=given)
    assert result.source_sha256 == given
    with pikepdf.open(tmp_path / "x.pdf") as doc:
        assert _text(_xmp(doc), "//rdf:Description/stare:sourceSha256") == given


def test_csv_path_defaults_to_the_tar_sidecar(tar_path, tmp_path, built):
    result = _build(tar_path, None, tmp_path / "x.pdf")
    assert result.output_sha256 == built[0].output_sha256


def test_volume_id_defaults_to_reporter_dir_and_volume(tmp_path, tar_path):
    vol = tmp_path / "a2d"
    vol.mkdir()
    (vol / "152.tar").write_bytes(tar_path.read_bytes())
    (vol / "152.tar.csv").write_bytes(Path(f"{tar_path}.csv").read_bytes())
    result = build_volume(vol / "152.tar", None, tmp_path / "out.pdf", G4Encoder(), created=CREATED)
    assert result.volume_id == "a2d/152"


@pytest.mark.jbig2
def test_jbig2_build(jbig2_encoder, tar_path, csv_path, tmp_path):
    result = _build(tar_path, csv_path, tmp_path / "jb2.pdf", jbig2_encoder)
    assert result.page_count == 4
    assert result.encoder == jbig2_encoder.name
    with pikepdf.open(tmp_path / "jb2.pdf") as doc:
        for page in doc.pages:
            (img,) = page.Resources.XObject.values()
            assert img.Filter == pikepdf.Name.JBIG2Decode
            assert "/DecodeParms" not in img
        tree = _xmp(doc)
        assert _text(tree, "//rdf:Description/stare:imageEncoderSettings").startswith("jbig2 -p -d")
    assert b"/JBIG2Globals" not in (tmp_path / "jb2.pdf").read_bytes()


def _assert_poppler_decodes_to_tiffs(pdf_path: Path, tmp_path: Path, volume) -> None:
    """poppler's pdfimages extracts each page image pixel-identical to its TIFF."""
    pdfimages = require("pdfimages")
    subprocess.run([pdfimages, "-png", str(pdf_path), str(tmp_path / "img")], check=True)
    vt, vol = volume
    for i, meta in enumerate(vol.mets.pages):
        with (
            Image.open(tmp_path / f"img-{i:03d}.png") as got,
            Image.open(io.BytesIO(vt.read(meta.tiff))) as src,
        ):
            assert got.convert("1").tobytes() == src.convert("1").tobytes(), meta.tiff


@pytest.mark.poppler
def test_g4_pages_decode_to_the_tiff_pixels_in_poppler(built, tmp_path, volume):
    _assert_poppler_decodes_to_tiffs(built[1], tmp_path, volume)


@pytest.mark.jbig2
@pytest.mark.poppler
def test_jbig2_pages_decode_to_the_tiff_pixels(jbig2_encoder, tar_path, csv_path, tmp_path, volume):
    require("pdfimages")
    _build(tar_path, csv_path, tmp_path / "jb2.pdf", jbig2_encoder)
    _assert_poppler_decodes_to_tiffs(tmp_path / "jb2.pdf", tmp_path, volume)


@pytest.mark.verapdf
def test_output_validates_as_pdfa_3b(built):
    cmd = verapdf_command(built[1])
    out = subprocess.run(cmd, capture_output=True, check=False).stdout.decode()
    assert out.startswith("PASS"), out


def _case(**kw) -> Case:
    base = {
        "case_id": None,
        "name": None,
        "name_abbreviation": None,
        "citation": None,
        "first_page": "5",
        "last_page": "9",
        "duplicative": False,
        "page_orders": (),
        "tiff_file_ids": (),
    }
    return Case(**{**base, **kw})


@pytest.mark.parametrize(
    ("case", "title"),
    [
        (
            _case(name="A v. B", name_abbreviation="A v. B.", citation="1 U.S. 1"),
            "A v. B., 1 U.S. 1",
        ),
        (_case(name="Full Name v. Other"), "Full Name v. Other"),
        (_case(), "Case 7 (pp. 5-9)"),
        (_case(duplicative=True, last_page=None), "Case 7 (pp. 5, duplicative)"),
    ],
)
def test_bookmark_title(case, title):
    assert bookmark_title(7, case) == title
