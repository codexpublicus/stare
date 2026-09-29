import io
import stat
from pathlib import Path

import pikepdf
import pytest
from fixture_paths import FIXTURES, TIFF_TEXT
from PIL import Image

from stare_archival.encoders import (
    JBIG2_FILE_MAGIC,
    PINNED_JBIG2_IMAGE,
    EncodedImage,
    G4Encoder,
    ImageEncoder,
    Jbig2Encoder,
    read_tiff,
)
from stare_archival.errors import EncodeError
from stare_archival.tarindex import VolumeTar


@pytest.fixture(scope="module")
def tiff_bytes() -> bytes:
    with VolumeTar.open(FIXTURES / "152.tar") as vt:
        return vt.read(TIFF_TEXT)


def _decode_in_pdf(encoded: EncodedImage) -> Image.Image:
    """Put the stream in a PDF image XObject and decode it the way a reader would."""
    pdf = pikepdf.new()
    xobj = pikepdf.Stream(pdf, encoded.data)
    for key, value in encoded.stream_dict().items():
        xobj[key] = value
    return pikepdf.PdfImage(xobj).as_pil_image()


def test_read_tiff_reports_size_and_resolution(tiff_bytes):
    info = read_tiff(tiff_bytes, TIFF_TEXT)
    with Image.open(io.BytesIO(tiff_bytes)) as im:
        assert (info.width, info.height) == im.size
    assert info.dpi == (300.0, 300.0)
    assert info.page_size == pytest.approx((info.width * 72 / 300, info.height * 72 / 300))


def test_read_tiff_without_resolution_assumes_300_dpi():
    buf = io.BytesIO()
    Image.new("1", (600, 300), 1).save(buf, "TIFF", compression="group4")
    info = read_tiff(buf.getvalue())
    assert info.dpi == (300.0, 300.0)
    assert info.page_size == pytest.approx((144.0, 72.0))


def test_read_tiff_rejects_garbage():
    with pytest.raises(EncodeError, match="<bad>"):
        read_tiff(b"not a tiff", "<bad>")


def test_g4_encoder_is_an_image_encoder():
    enc = G4Encoder()
    assert isinstance(enc, ImageEncoder)
    assert "G4" in enc.name
    assert "single strip" in enc.settings


def test_g4_encoder_writes_one_lossless_strip(tiff_bytes):
    encoded = G4Encoder().encode(tiff_bytes, TIFF_TEXT)
    with Image.open(io.BytesIO(tiff_bytes)) as src:
        assert (encoded.width, encoded.height) == src.size
        assert encoded.filter == "/CCITTFaxDecode"
        parms = encoded.decode_parms
        assert parms["/K"] == -1
        assert parms["/Columns"] == src.size[0]
        assert parms["/Rows"] == src.size[1]
        # the whole page in one stream, much smaller than the raw bitmap
        assert 0 < len(encoded.data) < src.size[0] * src.size[1] // 8
        decoded = _decode_in_pdf(encoded)
        # polarity: black stays black (Pillow writes MinIsBlack unless told otherwise)
        assert decoded.convert("1").tobytes() == src.convert("1").tobytes()


def test_g4_encoder_is_deterministic(tiff_bytes):
    assert G4Encoder().encode(tiff_bytes).data == G4Encoder().encode(tiff_bytes).data


def test_g4_encoder_rejects_non_bitonal_pages():
    buf = io.BytesIO()
    Image.new("L", (10, 10), 128).save(buf, "TIFF")
    with pytest.raises(EncodeError, match="bitonal"):
        G4Encoder().encode(buf.getvalue(), "<gray>")


def test_stream_dict_has_image_xobject_keys():
    encoded = EncodedImage(b"x", 10, 20, "/JBIG2Decode", None)
    d = encoded.stream_dict()
    assert d["/Type"] == pikepdf.Name.XObject
    assert d["/Subtype"] == pikepdf.Name.Image
    assert (d["/Width"], d["/Height"], d["/BitsPerComponent"]) == (10, 20, 1)
    assert d["/ColorSpace"] == pikepdf.Name.DeviceGray
    assert d["/Filter"] == pikepdf.Name.JBIG2Decode
    assert "/DecodeParms" not in d


# Jbig2Encoder: argument handling is tested against a stand-in script, so it runs without jbig2


def _fake_jbig2(tmp_path: Path, body: str) -> Path:
    script = tmp_path / "jbig2"
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def test_jbig2_encoder_runs_lossless_generic_mode(tmp_path, tiff_bytes):
    fake = _fake_jbig2(
        tmp_path,
        'if [ "$1" = "--version" ]; then echo "jbig2enc 9.99" >&2; exit 0; fi\n'
        'printf "%s|" "$@"; cmp -s "$3" "$STARE_TEST_TIFF" && printf "same"\n',
    )
    src = tmp_path / "page.tif"
    src.write_bytes(tiff_bytes)
    enc = Jbig2Encoder(str(fake), extra_env={"STARE_TEST_TIFF": str(src)})
    encoded = enc.encode(tiff_bytes, TIFF_TEXT)
    args = encoded.data.decode().split("|")
    assert args[:2] == ["-p", "-d"]
    assert args[-1] == "same"  # the TIFF reached jbig2 unchanged
    assert "-s" not in args
    assert encoded.filter == "/JBIG2Decode"
    assert encoded.decode_parms is None
    assert enc.name == "jbig2enc 9.99"
    assert enc.settings.startswith("jbig2 -p -d")


def test_jbig2_encoder_reports_failures(tmp_path, tiff_bytes):
    fake = _fake_jbig2(tmp_path, 'echo "cannot read" >&2; exit 3\n')
    with pytest.raises(EncodeError, match=r"cannot read"):
        Jbig2Encoder(str(fake)).encode(tiff_bytes, TIFF_TEXT)


def test_jbig2_encoder_rejects_a_jbig2_file_header(tmp_path, tiff_bytes):
    # a JBIG2 *file* (not -p "PDF ready" data) can't be embedded as-is
    fake = _fake_jbig2(tmp_path, "printf '\\227JB2\\r\\n\\032\\n'\n")
    with pytest.raises(EncodeError, match="file header"):
        Jbig2Encoder(str(fake)).encode(tiff_bytes, TIFF_TEXT)
    assert JBIG2_FILE_MAGIC == b"\x97JB2\r\n\x1a\n"


def test_jbig2_encoder_rejects_empty_output(tmp_path, tiff_bytes):
    fake = _fake_jbig2(tmp_path, "exit 0\n")
    with pytest.raises(EncodeError, match="no output"):
        Jbig2Encoder(str(fake)).encode(tiff_bytes, TIFF_TEXT)


def test_jbig2_docker_command_uses_the_pinned_image():
    enc = Jbig2Encoder.docker()
    cmd = enc.command(["-p", "-d"], "-")
    assert cmd[:4] == ["docker", "run", "--rm", "-i"]
    assert "--network=none" in cmd
    assert PINNED_JBIG2_IMAGE in cmd
    assert PINNED_JBIG2_IMAGE.startswith("jbarlow83/ocrmypdf:v16.10.4@sha256:")
    assert cmd[-1].endswith("jbig2 -p -d /tmp/page.tif")


def test_locate_prefers_the_env_var(tmp_path):
    fake = _fake_jbig2(tmp_path, "exit 0\n")
    enc = Jbig2Encoder.locate(env={"STARE_JBIG2": str(fake), "PATH": ""})
    assert enc is not None
    assert enc.binary == str(fake)


def test_locate_env_var_docker_selects_the_image():
    enc = Jbig2Encoder.locate(env={"STARE_JBIG2": "docker", "PATH": ""})
    assert enc is not None
    assert enc.docker_image == PINNED_JBIG2_IMAGE


def test_locate_env_var_none_opts_out(tmp_path):
    _fake_jbig2(tmp_path, "exit 0\n")
    assert Jbig2Encoder.locate(env={"STARE_JBIG2": "none", "PATH": str(tmp_path)}) is None


def test_locate_env_var_must_point_at_an_executable(tmp_path):
    with pytest.raises(EncodeError, match="STARE_JBIG2"):
        Jbig2Encoder.locate(env={"STARE_JBIG2": str(tmp_path / "nope"), "PATH": ""})


def test_locate_finds_jbig2_on_path(tmp_path):
    fake = _fake_jbig2(tmp_path, "exit 0\n")
    enc = Jbig2Encoder.locate(env={"PATH": str(tmp_path)}, docker=False)
    assert enc is not None
    assert enc.binary == str(fake)


def test_locate_returns_none_without_jbig2(tmp_path):
    assert Jbig2Encoder.locate(env={"PATH": str(tmp_path)}, docker=False) is None


@pytest.mark.jbig2
def test_real_jbig2_output_is_pdf_ready_generic_region(jbig2_encoder, tiff_bytes):
    encoded = jbig2_encoder.encode(tiff_bytes, TIFF_TEXT)
    assert encoded.filter == "/JBIG2Decode"
    assert not encoded.data.startswith(JBIG2_FILE_MAGIC)
    # segment 0 is the page information segment (type 48), then an immediate lossless
    # generic region (type 38 or 39); a text region (6/7) or symbol dictionary (0) would
    # mean symbol coding
    types = _segment_types(encoded.data)
    assert types[0] == 48
    assert set(types) & {38, 39}
    assert not set(types) & {0, 4, 6, 7}
    assert jbig2_encoder.name.startswith("jbig2enc ")


def _segment_types(data: bytes) -> list[int]:
    """Segment types of an embedded (PDF) JBIG2 stream (7.2 of ITU T.88)."""
    types, pos = [], 0
    while pos < len(data):
        flags = data[pos + 4]
        types.append(flags & 0x3F)
        page_assoc_4 = bool(flags & 0x40)
        count_byte = data[pos + 5]
        n_refs = count_byte >> 5
        if n_refs == 7:
            raise AssertionError("long-form referred-to segment count not expected")
        pos += 6
        seg_no = int.from_bytes(data[pos - 6 : pos - 2], "big")
        ref_size = 1 if seg_no <= 256 else 2 if seg_no <= 65536 else 4
        pos += n_refs * ref_size
        pos += 4 if page_assoc_4 else 1
        length = int.from_bytes(data[pos : pos + 4], "big")
        pos += 4
        if length == 0xFFFFFFFF:
            raise AssertionError("unknown-length segment not expected")
        pos += length
    return types
