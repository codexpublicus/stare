import io

import pytest
from fixture_paths import METS, ROOT
from PIL import Image

from stare_archival.alto import parse_alto
from stare_archival.errors import MemberNotFoundError, MetadataError
from stare_archival.tarindex import Member, TarIndex, VolumeTar
from stare_archival.volume import load_volume


@pytest.fixture
def volume(tar_path):
    with VolumeTar.open(tar_path) as vt:
        return load_volume(vt)


def test_load_volume_finds_mets_and_cases(volume):
    assert volume.mets_path == METS
    assert volume.boxes_path is None
    assert [p.order for p in volume.mets.pages] == [870, 871, 872, 873]
    assert [(ref.order, case.duplicative) for ref, case in volume.cases] == [
        (201, True),
        (202, False),
        (203, True),
    ]
    assert volume.cases[1][1].name_abbreviation == "Bondy v. Pappas"


def test_fixture_pages_are_consistent_across_tiff_and_alto(tar_path, volume):
    words = []
    with VolumeTar.open(tar_path) as vt:
        for page in volume.mets.pages:
            alto = parse_alto(vt.read(page.alto), page.alto)
            with Image.open(io.BytesIO(vt.read(page.tiff))) as im:
                assert im.mode == "1"
                assert im.info["dpi"] == (300.0, 300.0)
                assert im.size == (alto.width, alto.height)
            words.append(len(alto.words))
    assert words == [0, 302, 251, 0]


def test_load_volume_reports_boxes_when_present(csv_path, tar_path):
    index = TarIndex.from_csv(csv_path)
    boxes = Member(f"{ROOT}/{ROOT}_BOXES.xml.gz", 999_424, 0)
    with VolumeTar(open(tar_path, "rb"), TarIndex([*index, boxes])) as vt:  # noqa: SIM115
        assert load_volume(vt).boxes_path == boxes.path


def test_load_volume_without_mets(csv_path, tar_path):
    index = TarIndex([m for m in TarIndex.from_csv(csv_path) if m.path != METS])
    with (
        VolumeTar(open(tar_path, "rb"), index) as vt,  # noqa: SIM115
        pytest.raises(MetadataError, match="METS"),
    ):
        load_volume(vt)


def test_load_volume_with_missing_casemets(csv_path, tar_path):
    index = TarIndex([m for m in TarIndex.from_csv(csv_path) if "CASEMETS_0202" not in m.path])
    with (
        VolumeTar(open(tar_path, "rb"), index) as vt,  # noqa: SIM115
        pytest.raises(MemberNotFoundError, match="CASEMETS_0202"),
    ):
        load_volume(vt)
