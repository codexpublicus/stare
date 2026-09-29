import io
import stat
from pathlib import Path

import pikepdf
import pytest
from fixture_paths import FIXTURES, TIFF_TEXT
from PIL import Image

from stare_archival.encoders import (
    JBIG2_FILE_MAGIC,
    EncodedImage,
    G4Encoder,
    ImageEncoder,
    Jbig2Encoder,
    check_jbig2_generic,
    jbig2_segment_types,
    read_tiff,
)
from stare_archival.errors import EncodeError
from stare_archival.images import PINNED_JBIG2_IMAGE
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


def _segment(number: int, kind: int, data: bytes = b"", refs: tuple[int, ...] = ()) -> bytes:
    """One JBIG2 segment as embedded in a PDF (ITU T.88 7.2): short-form header, 1-byte page
    association."""
    return (
        number.to_bytes(4, "big")
        + bytes([kind, len(refs) << 5, *refs, 1])
        + len(data).to_bytes(4, "big")
        + data
    )


PAGE_INFO = _segment(0, 48, bytes(19))
GENERIC = _segment(1, 38, b"\x01\x02\x03")
END_OF_PAGE = _segment(2, 49)
VALID_STREAM = PAGE_INFO + GENERIC + END_OF_PAGE


def _fake_jbig2(tmp_path: Path, body: str, name: str = "jbig2") -> Path:
    script = tmp_path / name
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _emitting(tmp_path: Path, stream: bytes) -> Path:
    """A stand-in jbig2 that writes `stream` to stdout."""
    (tmp_path / "out.jb2").write_bytes(stream)
    return _fake_jbig2(tmp_path, f'cat "{tmp_path / "out.jb2"}"\n')


def test_segment_walk_reads_types():
    assert jbig2_segment_types(VALID_STREAM) == [48, 38, 49]


def test_generic_region_stream_passes_the_check():
    check_jbig2_generic(VALID_STREAM, "<ok>")


@pytest.mark.parametrize(
    ("stream", "message"),
    [
        (PAGE_INFO + _segment(1, 0, b"x") + GENERIC, "segment type 0"),  # symbol dictionary
        (PAGE_INFO + _segment(1, 6, b"x"), "segment type 6"),  # text region
        (PAGE_INFO + _segment(1, 42, b"x"), "segment type 42"),  # refinement region
        (PAGE_INFO + _segment(1, 38, b"x", refs=(0,)), "refers to"),  # would need globals
        (GENERIC + END_OF_PAGE, "page information"),
        (PAGE_INFO + END_OF_PAGE, "no generic region"),
        (PAGE_INFO + GENERIC[:-2], "truncated"),
        (b"", "truncated"),
    ],
)
def test_non_generic_or_malformed_streams_are_rejected(stream, message):
    with pytest.raises(EncodeError, match=message):
        check_jbig2_generic(stream, "<bad>")


def test_jbig2_encoder_runs_lossless_generic_mode(tmp_path, tiff_bytes):
    (tmp_path / "out.jb2").write_bytes(VALID_STREAM)
    fake = _fake_jbig2(
        tmp_path,
        'if [ "$1" = "--version" ]; then echo "jbig2enc 9.99" >&2; exit 0; fi\n'
        'printf "%s|" "$@" > "$STARE_TEST_ARGS"\n'
        'cmp -s "$3" "$STARE_TEST_TIFF" && cat "$STARE_TEST_OUT"\n',
    )
    src = tmp_path / "page.tif"
    src.write_bytes(tiff_bytes)
    args_file = tmp_path / "args"
    enc = Jbig2Encoder(
        str(fake),
        extra_env={
            "STARE_TEST_TIFF": str(src),
            "STARE_TEST_ARGS": str(args_file),
            "STARE_TEST_OUT": str(tmp_path / "out.jb2"),
        },
    )
    encoded = enc.encode(tiff_bytes, TIFF_TEXT)
    assert encoded.data == VALID_STREAM  # written only if the TIFF reached jbig2 unchanged
    args = args_file.read_text().split("|")
    assert args[:2] == ["-p", "-d"]
    assert "-s" not in args
    assert encoded.filter == "/JBIG2Decode"
    assert encoded.decode_parms is None
    assert enc.name == "jbig2enc 9.99"
    assert enc.settings.startswith("jbig2 -p -d")


def test_jbig2_encoder_rejects_symbol_coded_output(tmp_path, tiff_bytes):
    fake = _emitting(tmp_path, PAGE_INFO + _segment(1, 0, b"x") + _segment(2, 6, b"y"))
    with pytest.raises(EncodeError, match=r"32044109578831_00436_0.tif.*segment type 0"):
        Jbig2Encoder(str(fake)).encode(tiff_bytes, TIFF_TEXT)


def test_jbig2_encoder_reports_failures(tmp_path, tiff_bytes):
    fake = _fake_jbig2(tmp_path, 'echo "cannot read" >&2; exit 3\n')
    with pytest.raises(EncodeError, match=r"cannot read"):
        Jbig2Encoder(str(fake)).encode(tiff_bytes, TIFF_TEXT)


def test_jbig2_encoder_rejects_a_jbig2_file_header(tmp_path, tiff_bytes):
    # a JBIG2 *file* (not -p "PDF ready" data) can't be embedded as-is
    fake = _emitting(tmp_path, JBIG2_FILE_MAGIC + VALID_STREAM)
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


def test_locate_env_var_docker_selects_the_image(tmp_path):
    docker = _fake_jbig2(tmp_path, "exit 0\n", name="docker")
    enc = Jbig2Encoder.locate(env={"STARE_JBIG2": "docker", "PATH": str(tmp_path)})
    assert enc is not None
    assert enc.docker_image == PINNED_JBIG2_IMAGE
    assert enc.command(["--version"])[0] == str(docker)


def test_locate_runs_the_docker_it_probed(tmp_path):
    # no jbig2 on PATH, but a docker that has the image: the same docker runs it
    docker = _fake_jbig2(tmp_path, 'test "$1 $2" = "image inspect" || exit 1\n', "docker")
    enc = Jbig2Encoder.locate(env={"PATH": str(tmp_path)})
    assert enc is not None
    assert enc.docker_image == PINNED_JBIG2_IMAGE
    assert enc.command(["-p", "-d"], "-")[0] == str(docker)


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
    # encode() itself rejects anything but page info + generic region (+ end of page/stripe)
    encoded = jbig2_encoder.encode(tiff_bytes, TIFF_TEXT)
    assert encoded.filter == "/JBIG2Decode"
    assert not encoded.data.startswith(JBIG2_FILE_MAGIC)
    types = jbig2_segment_types(encoded.data)
    assert types[0] == 48
    assert set(types) & {38, 39}
    assert jbig2_encoder.name.startswith("jbig2enc ")
