import io
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pikepdf
import pytest
from fixture_paths import FIXTURES, TIFF_TEXT
from PIL import Image
from tools import verapdf_tool

from stare_archival.build import build_volume
from stare_archival.encoders import EncodedImage, G4Encoder
from stare_archival.errors import ToolError, VerifyError
from stare_archival.external import Poppler
from stare_archival.verify import (
    CHECKS,
    ExtractedWord,
    compare_bitonal,
    compare_page_text,
    read_sha256_file,
    verify_volume,
)

CREATED = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)
SHA = "f5d8bcd4debc8ca87e54a14d7bc0054337b8dd4aca8a10ee6884d3f5d1d23941"
LABELS = ["838", "839", "840", "841"]
TM = re.compile(rb"1 0 0 1 ([0-9.]+) ([0-9.]+) Tm")


# --- pure helpers (no external tools) ---------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [SHA, SHA + "\n", SHA.upper(), f"{SHA}  152.tar\n", f"{SHA} *152.tar"],
)
def test_read_sha256_file_accepts_bare_and_sha256sum_formats(tmp_path, text):
    path = tmp_path / "152.tar.sha256"
    path.write_text(text)
    assert read_sha256_file(path) == SHA


@pytest.mark.parametrize("text", ["", "abc", SHA[:-1], SHA + "0", "zz" * 32, f"{SHA} {SHA}"])
def test_read_sha256_file_rejects_anything_else(tmp_path, text):
    path = tmp_path / "152.tar.sha256"
    path.write_text(text)
    with pytest.raises(VerifyError, match=r"152\.tar\.sha256"):
        read_sha256_file(path)


def _word(text, x0, top, x1, bottom):
    return ExtractedWord(text, x0, top, x1, bottom)


def test_compare_page_text_passes_when_words_and_positions_agree():
    expected = [_word("Bondy", 10, 20, 40, 30), _word("v.", 45, 20, 50, 30)]
    # pdftotext's order and vertical extent differ; only x edges and the centre line count
    got = [_word("v.", 45.1, 19, 50.1, 31), _word("Bondy", 10, 18.6, 40, 31.2)]
    result = compare_page_text(expected, got, tolerance=1.0)
    assert result.chars_ok and result.positions_ok
    assert result.matched == 2 and result.unmatched == 0
    assert result.max_deviation == pytest.approx(0.1)


def test_compare_page_text_ignores_whitespace_and_hyphens():
    expected = [_word("argu-", 0, 0, 10, 10), _word("ment", 0, 12, 10, 22)]
    got = [_word("argument", 0, 0, 20, 10)]
    result = compare_page_text(expected, got, tolerance=1.0)
    assert result.chars_ok
    assert result.unmatched == 2  # words pdftotext merged can't be positioned


def test_compare_page_text_reports_missing_and_extra_characters():
    result = compare_page_text(
        [_word("839", 0, 0, 10, 10)], [_word("838", 0, 0, 10, 10)], tolerance=1.0
    )
    assert not result.chars_ok
    assert result.missing == {"9": 1}
    assert result.extra == {"8": 1}


def test_compare_page_text_reports_words_out_of_position():
    expected = [_word("Bondy", 10, 20, 40, 30), _word("Bondy", 10, 60, 40, 70)]
    got = [_word("Bondy", 10, 20, 40, 30), _word("Bondy", 35, 60, 65, 70)]
    result = compare_page_text(expected, got, tolerance=1.0)
    assert result.chars_ok
    assert not result.positions_ok
    (bad,) = result.misplaced
    assert bad.text == "Bondy"
    assert bad.deviation == pytest.approx(25)


def _page(size=(8, 4), black=()):
    im = Image.new("1", size, 1)
    for xy in black:
        im.putpixel(xy, 0)
    return im


def test_compare_bitonal_equal_images():
    assert compare_bitonal(_page(black=[(1, 1)]), _page(black=[(1, 1)])) is None


def test_compare_bitonal_counts_differing_pixels_and_their_box():
    msg = compare_bitonal(_page(black=[(1, 1)]), _page(black=[(5, 2), (6, 3)]))
    assert msg == "3 pixels differ, within x 1-6, y 1-3"


def test_compare_bitonal_reports_a_size_mismatch():
    assert compare_bitonal(_page((8, 4)), _page((8, 5))) == "size 8x5, the TIFF is 8x4"


def test_compare_bitonal_thresholds_grey_decodes_without_dithering():
    grey = _page(black=[(2, 2)]).convert("L")
    assert compare_bitonal(_page(black=[(2, 2)]), grey) is None


def test_verify_needs_poppler(tmp_path):
    assert Poppler.locate(env={"PATH": str(tmp_path)}) is None
    with pytest.raises(ToolError, match="pdfimages"):
        verify_volume(
            tmp_path / "x.pdf",
            FIXTURES / "152.tar",
            poppler=None,
            env={"PATH": str(tmp_path)},
        )


# --- whole-volume verification (poppler) ------------------------------------------------


def _build(out: Path, encoder=None, tar: Path | None = None, **kw) -> Path:
    kw.setdefault("volume_id", "a2d/152")
    kw.setdefault("created", CREATED)
    build_volume(tar or FIXTURES / "152.tar", None, out, encoder or G4Encoder(), **kw)
    return out


@pytest.fixture(scope="module")
def g4_pdf(tmp_path_factory) -> Path:
    return _build(tmp_path_factory.mktemp("g4") / "152.pdf")


@pytest.fixture
def poppler() -> Poppler:
    found = Poppler.locate()
    if found is None:
        pytest.skip("poppler (pdfimages, pdftotext) is not on PATH")
    return found


def _statuses(report) -> dict[str, str]:
    return {c.name: c.status for c in report.checks}


@pytest.mark.poppler
def test_a_good_g4_build_passes_every_check(g4_pdf, poppler):
    report = verify_volume(g4_pdf, FIXTURES / "152.tar", poppler=poppler)
    assert report.ok, report.failures
    assert list(_statuses(report)) == list(CHECKS)
    assert _statuses(report) == {
        "source_sha256": "pass",
        "structure": "pass",
        "no_jbig2_globals": "pass",
        "image_streams": "pass",
        "image_pixels": "pass",
        "text_chars": "pass",
        "text_positions": "pass",
        "pdfa": "skipped",
    }
    assert report.volume_id == "a2d/152"
    assert report.page_count == 4
    assert report.labels == tuple(LABELS)
    assert report.encoder == G4Encoder().name
    assert report.encoder_settings == G4Encoder().settings
    assert report.output_size == g4_pdf.stat().st_size
    assert len(report.output_sha256) == 64
    assert report.source_sha256 == report.embedded_source_sha256
    assert report.recorded_source_sha256 is None  # the fixture has no .tar.sha256
    pixels = report.check("image_pixels")
    assert pixels.detail["pages_compared"] == 4
    assert pixels.detail["decoders"] == {"/CCITTFaxDecode": "pikepdf"}
    text = report.check("text_positions")
    assert text.detail["words_positioned"] == 302 + 251
    assert text.detail["tolerance_pt"] == 1.0
    assert text.detail["max_deviation_pt"] < 0.5
    assert report.tools["pdftotext"].startswith("pdftotext version")
    json.dumps(report.to_dict())


@pytest.mark.jbig2
@pytest.mark.poppler
def test_a_good_jbig2_build_passes_with_poppler_as_the_decoder(jbig2_encoder, poppler, tmp_path):
    pdf = _build(tmp_path / "jb2.pdf", jbig2_encoder)
    report = verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler)
    assert report.ok, report.failures
    detail = report.check("image_pixels").detail
    assert detail["decoders"] == {"/JBIG2Decode": poppler.version}
    assert report.check("image_streams").detail["filters"] == {"/JBIG2Decode": 4}


class _FlipOnePixel:
    """Encodes one page from a TIFF that differs from the tar's by one pixel."""

    def __init__(self, inner, target: str, xy: tuple[int, int]) -> None:
        self.inner, self.target, self.xy = inner, target, xy
        self.name, self.settings = inner.name, inner.settings

    def encode(self, tiff: bytes, path: str = "<TIFF>") -> EncodedImage:
        if path == self.target:
            with Image.open(io.BytesIO(tiff)) as im:
                im = im.copy()
            im.putpixel(self.xy, 255 - im.getpixel(self.xy))
            buf = io.BytesIO()
            im.save(buf, "TIFF", compression="group4", dpi=(300, 300))
            tiff = buf.getvalue()
        return self.inner.encode(tiff, path)


def _pixel_failure(report):
    assert not report.ok
    assert _statuses(report)["image_pixels"] == "fail"
    (failure,) = report.check("image_pixels").failures
    assert failure.check == "image_pixels"
    assert (failure.page, failure.order, failure.label) == (2, 871, "839")
    assert failure.message == "1 pixel differs, within x 700-700, y 900-900"
    return failure


@pytest.mark.poppler
def test_a_tampered_g4_page_image_fails_on_that_page(poppler, tmp_path):
    enc = _FlipOnePixel(G4Encoder(), TIFF_TEXT, (700, 900))
    pdf = _build(tmp_path / "bad.pdf", enc)
    report = verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler)
    _pixel_failure(report)
    others = {c.name for c in report.checks if c.status == "fail"}
    assert others == {"image_pixels"}


@pytest.mark.jbig2
@pytest.mark.poppler
def test_a_tampered_jbig2_page_image_fails_on_that_page(jbig2_encoder, poppler, tmp_path):
    enc = _FlipOnePixel(jbig2_encoder, TIFF_TEXT, (700, 900))
    pdf = _build(tmp_path / "bad.pdf", enc)
    _pixel_failure(verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler))


def _edit_page_content(src: Path, dest: Path, page: int, edit) -> Path:
    with pikepdf.open(src) as doc:
        pg = doc.pages[page]
        pg.Contents.write(edit(pg.Contents.read_bytes()))
        doc.save(dest)
    return dest


@pytest.mark.poppler
def test_a_changed_word_in_the_text_layer_fails_text_chars(g4_pdf, poppler, tmp_path):
    # page 2's first run is "839" (the printed page number); make it "838"
    pdf = _edit_page_content(
        g4_pdf, tmp_path / "t.pdf", 1, lambda b: b.replace(b"<003800330039>", b"<003800330038>", 1)
    )
    report = verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler)
    assert _statuses(report)["text_chars"] == "fail"
    (failure,) = report.check("text_chars").failures
    assert (failure.page, failure.order, failure.label) == (2, 871, "839")
    assert "missing {'9': 1}" in failure.message and "extra {'8': 1}" in failure.message
    assert _statuses(report)["image_pixels"] == "pass"


@pytest.mark.poppler
def test_a_moved_word_in_the_text_layer_fails_text_positions(g4_pdf, poppler, tmp_path):
    def shift_first_word(content: bytes) -> bytes:
        m = TM.search(content)
        moved = b"1 0 0 1 %.2f %s Tm" % (float(m.group(1)) + 20, m.group(2))
        return content[: m.start()] + moved + content[m.end() :]

    pdf = _edit_page_content(g4_pdf, tmp_path / "t.pdf", 1, shift_first_word)
    report = verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler)
    statuses = _statuses(report)
    assert statuses["text_chars"] == "pass"
    assert statuses["text_positions"] == "fail"
    (failure,) = report.check("text_positions").failures
    assert failure.page == 2
    assert "'839'" in failure.message and "20.0" in failure.message


@pytest.mark.poppler
def test_a_visible_text_layer_fails_image_streams(g4_pdf, poppler, tmp_path):
    pdf = _edit_page_content(
        g4_pdf, tmp_path / "t.pdf", 1, lambda b: b.replace(b"3 Tr", b"0 Tr", 1)
    )
    report = verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler)
    (failure,) = report.check("image_streams").failures
    assert failure.page == 2 and "render mode 0" in failure.message


@pytest.mark.poppler
def test_jbig2_globals_anywhere_fail(g4_pdf, poppler, tmp_path):
    with pikepdf.open(g4_pdf) as doc:
        globals_ = doc.make_indirect(pikepdf.Stream(doc, b"\x00" * 16))
        doc.Root.StareTest = pikepdf.Dictionary(JBIG2Globals=globals_)
        doc.save(tmp_path / "g.pdf")
    report = verify_volume(tmp_path / "g.pdf", FIXTURES / "152.tar", poppler=poppler)
    assert _statuses(report)["no_jbig2_globals"] == "fail"
    (failure,) = report.check("no_jbig2_globals").failures
    assert failure.page is None and "JBIG2Globals" in failure.message


@pytest.mark.poppler
def test_a_missing_page_fails_structure_and_skips_page_checks(g4_pdf, poppler, tmp_path):
    with pikepdf.open(g4_pdf) as doc:
        del doc.pages[3]
        doc.save(tmp_path / "short.pdf")
    report = verify_volume(tmp_path / "short.pdf", FIXTURES / "152.tar", poppler=poppler)
    statuses = _statuses(report)
    assert statuses["structure"] == "fail"
    assert "3 pages, the METS lists 4" in report.check("structure").failures[0].message
    for name in ("image_streams", "image_pixels", "text_chars", "text_positions"):
        assert statuses[name] == "skipped"


def _tar_copy(dest: Path, sha256: str | None) -> Path:
    tar = dest / "152.tar"
    shutil.copyfile(FIXTURES / "152.tar", tar)
    shutil.copyfile(FIXTURES / "152.tar.csv", dest / "152.tar.csv")
    if sha256 is not None:
        (dest / "152.tar.sha256").write_text(sha256)
    return tar


@pytest.mark.poppler
def test_the_recorded_tar_sha256_is_checked_when_present(g4_pdf, poppler, tmp_path):
    good = _tar_copy(tmp_path, None)
    computed = verify_volume(g4_pdf, good, poppler=poppler).source_sha256
    (tmp_path / "152.tar.sha256").write_text(computed)
    report = verify_volume(g4_pdf, good, poppler=poppler)
    assert report.ok
    assert report.recorded_source_sha256 == computed


@pytest.mark.poppler
def test_a_wrong_recorded_tar_sha256_fails(g4_pdf, poppler, tmp_path):
    tar = _tar_copy(tmp_path, "0" * 64)
    report = verify_volume(g4_pdf, tar, poppler=poppler)
    assert not report.ok
    (failure,) = report.check("source_sha256").failures
    assert failure.page is None
    assert "152.tar.sha256 records 0000" in failure.message
    assert report.source_sha256 in failure.message


@pytest.mark.poppler
def test_a_pdf_built_from_another_tar_sha256_fails(poppler, tmp_path):
    pdf = _build(tmp_path / "other.pdf", source_sha256="1" * 64)
    report = verify_volume(pdf, FIXTURES / "152.tar", poppler=poppler)
    (failure,) = report.check("source_sha256").failures
    assert "the PDF records 1111" in failure.message


@pytest.mark.poppler
def test_an_explicit_sha256_file_must_exist(g4_pdf, poppler, tmp_path):
    with pytest.raises(VerifyError, match="nope.sha256"):
        verify_volume(
            g4_pdf, FIXTURES / "152.tar", poppler=poppler, sha256_path=tmp_path / "nope.sha256"
        )


@pytest.mark.poppler
def test_an_unreadable_pdf_raises_verify_error(poppler, tmp_path):
    (tmp_path / "junk.pdf").write_bytes(b"not a pdf")
    with pytest.raises(VerifyError, match="junk.pdf"):
        verify_volume(tmp_path / "junk.pdf", FIXTURES / "152.tar", poppler=poppler)


@pytest.mark.poppler
@pytest.mark.verapdf
def test_verapdf_validation_is_a_check_when_asked_for(g4_pdf, poppler):
    report = verify_volume(g4_pdf, FIXTURES / "152.tar", poppler=poppler, verapdf=verapdf_tool())
    pdfa = report.check("pdfa")
    assert pdfa.status == "pass", pdfa.failures
    assert pdfa.detail["flavour"] == "3b"
    assert report.tools["verapdf"].startswith("veraPDF 1.30.2")
