import gzip
import io
import tarfile

import pytest
from fixture_paths import ALTO_TEXT, METS, ROOT, TIFF_TEXT

from stare_archival.errors import (
    MemberNotFoundError,
    MemberReadError,
    MetadataError,
    TarIndexError,
)
from stare_archival.tarindex import Member, TarIndex, VolumeTar, gunzip_member, resolve_href

# --- TarIndex ---------------------------------------------------------------


def test_index_reads_fixture_csv_with_crlf(csv_path):
    assert b"\r\n" in csv_path.read_bytes()
    index = TarIndex.from_csv(csv_path)
    assert len(index) == 16
    assert index.root == ROOT
    assert index[ALTO_TEXT] == Member(ALTO_TEXT, 3072, 10440)
    assert ALTO_TEXT in index
    assert f"{ROOT}/nope.xml" not in index


def test_index_preserves_csv_order(csv_path):
    paths = [m.path for m in TarIndex.from_csv(csv_path)]
    assert paths[0] == ROOT
    assert paths[-1] == METS


def test_index_reads_the_mirror_manifest_for_the_whole_volume(source_csv_path):
    index = TarIndex.from_csv(source_csv_path)
    assert len(index) == 3400
    assert index.root == ROOT
    assert index[METS] == Member(METS, 68231168, 121748)
    assert len(index.glob(f"{ROOT}/casemets/*.xml.gz")) == 225
    assert len(index.glob(f"{ROOT}/images/*.tif")) == 1056


@pytest.mark.parametrize(
    "source",
    [
        b"path,offset,size\na/b,512,3\n",
        b"path,offset,size\r\na/b,512,3\r\n",
        b"path,offset,size\na/b,512,3",
        io.BytesIO(b"path,offset,size\na/b,512,3\n"),
        io.StringIO("path,offset,size\na/b,512,3\n"),
        b"\xef\xbb\xbfpath,offset,size\na/b,512,3\n\n",
    ],
)
def test_index_accepts_bytes_and_file_likes(source):
    index = TarIndex.from_csv(source)
    assert list(index) == [Member("a/b", 512, 3)]


def test_index_accepts_a_str_path(csv_path):
    assert len(TarIndex.from_csv(str(csv_path))) == 16


@pytest.mark.parametrize(
    ("text", "needle"),
    [
        (b"", "empty"),
        (b"name,offset,size\na,512,0\n", "header"),
        (b"path,offset,size\na,512\n", "line 2"),
        (b"path,offset,size\na,x,0\n", "line 2"),
        (b"path,offset,size\na,512,0\nb,-1,0\n", "line 3"),
        (b"path,offset,size\na,512,0\na,1024,0\n", "duplicate"),
        (b"path,offset,size\n,512,0\n", "line 2"),
        (b"path,offset,size\na,100,0\n", "line 2"),
    ],
)
def test_index_rejects_malformed_csv(text, needle):
    with pytest.raises(TarIndexError, match=needle):
        TarIndex.from_csv(text)


def test_index_missing_member_error_names_the_path(csv_path):
    index = TarIndex.from_csv(csv_path)
    with pytest.raises(MemberNotFoundError, match="nope.tif"):
        index[f"{ROOT}/images/nope.tif"]


def test_index_root_requires_a_single_top_level_directory():
    index = TarIndex.from_csv(b"path,offset,size\na/x,512,0\nb/y,1024,0\n")
    with pytest.raises(TarIndexError, match="top-level"):
        _ = index.root


def test_index_glob(csv_path):
    index = TarIndex.from_csv(csv_path)
    assert [m.path.rsplit("_", 1)[-1] for m in index.glob(f"{ROOT}/casemets/*.xml.gz")] == [
        "0201.xml.gz",
        "0202.xml.gz",
        "0203.xml.gz",
    ]


# --- VolumeTar --------------------------------------------------------------


def expected_member_bytes(tar_path, path):
    with tarfile.open(tar_path) as tf:
        return tf.extractfile(path).read()


def test_read_returns_member_bytes_by_range(tar_path, csv_path):
    with VolumeTar.open(tar_path, csv_path) as vt:
        assert vt.root == ROOT
        assert vt.read(TIFF_TEXT) == expected_member_bytes(tar_path, TIFF_TEXT)
        assert vt.read(ALTO_TEXT) == expected_member_bytes(tar_path, ALTO_TEXT)
        assert vt.read(ROOT) == b""


def test_open_defaults_csv_to_tar_path_plus_csv(tar_path):
    with VolumeTar.open(tar_path) as vt:
        assert len(vt.index) == 16


def test_read_decoded_gunzips_gz_members(tar_path):
    with VolumeTar.open(tar_path) as vt:
        xml = vt.read_decoded(ALTO_TEXT)
        assert xml.startswith(b"<?xml")
        # non-gz members come back unchanged
        assert vt.read_decoded(TIFF_TEXT) == vt.read(TIFF_TEXT)


def test_read_from_any_file_like(tar_path, csv_path):
    index = TarIndex.from_csv(csv_path)
    vt = VolumeTar(io.BytesIO(tar_path.read_bytes()), index)
    assert vt.read(TIFF_TEXT) == expected_member_bytes(tar_path, TIFF_TEXT)


def test_open_closes_its_file(tar_path):
    vt = VolumeTar.open(tar_path)
    vt.close()
    with pytest.raises(ValueError):
        vt.read(TIFF_TEXT)


def test_read_missing_member(tar_path):
    with VolumeTar.open(tar_path) as vt, pytest.raises(MemberNotFoundError, match="missing.tif"):
        vt.read(f"{ROOT}/images/missing.tif")


def test_read_truncated_tar_raises(tar_path, csv_path):
    data = tar_path.read_bytes()
    index = TarIndex.from_csv(csv_path)
    member = index[TIFF_TEXT]
    cut = io.BytesIO(data[: member.offset + member.size // 2])
    with pytest.raises(MemberReadError, match="short read"):
        VolumeTar(cut, index).read(TIFF_TEXT)


def test_read_checks_the_tar_header_before_the_member(tar_path, csv_path):
    index = TarIndex.from_csv(csv_path)
    real = index[TIFF_TEXT]
    # point the TIFF's entry at the ALTO member's data: header name and size won't match
    alto = index[ALTO_TEXT]
    others = [m for m in index if m.path != TIFF_TEXT]
    wrong = TarIndex([*others, Member(TIFF_TEXT, alto.offset, real.size)])
    with (
        VolumeTar(open(tar_path, "rb"), wrong) as vt,  # noqa: SIM115
        pytest.raises(MemberReadError, match="header"),
    ):
        vt.read(TIFF_TEXT)
    with VolumeTar(open(tar_path, "rb"), wrong, check_headers=False) as vt:  # noqa: SIM115
        assert len(vt.read(TIFF_TEXT)) == real.size


# --- helpers ----------------------------------------------------------------


def test_gunzip_member_passes_plain_bytes_through():
    assert gunzip_member(b"<xml/>", "a.xml") == b"<xml/>"
    assert gunzip_member(gzip.compress(b"<xml/>"), "a.xml.gz") == b"<xml/>"


def test_gunzip_member_reports_corrupt_gzip():
    bad = gzip.compress(b"<xml/>" * 100)[:30]
    with pytest.raises(MetadataError, match="a.xml.gz"):
        gunzip_member(bad, "a.xml.gz")


@pytest.mark.parametrize(
    ("base", "href", "expected"),
    [
        (ROOT, "images/x.tif", f"{ROOT}/images/x.tif"),
        (f"{ROOT}/casemets", "../images/x.tif", f"{ROOT}/images/x.tif"),
        (f"{ROOT}/casemets", "./../alto/y.xml.gz", f"{ROOT}/alto/y.xml.gz"),
    ],
)
def test_resolve_href(base, href, expected):
    assert resolve_href(base, href) == expected


@pytest.mark.parametrize("href", ["../../etc/passwd", "/abs/path", "http://x/y"])
def test_resolve_href_rejects_escapes(href):
    with pytest.raises(MetadataError):
        resolve_href(f"{ROOT}/casemets", href)
