"""Volume and page lookups against a CAP index version."""

from pathlib import Path

import pytest
from exportkit import write_index

from stare_courtlistener.capindex import (
    CapIndex,
    Match,
    PageIndex,
    folder_volume,
    page_key,
    volume_key,
)


@pytest.mark.parametrize(
    ("page", "key"),
    [
        ("1012", 1012),
        ("01012", 1012),
        ("428e", 428),
        ("[106]", 106),
        ("B174", 174),
        ("1265=1275", 1265),
        ("xxix", "xxix"),
        ("000", 0),
    ],
)
def test_page_key(page: str, key: int | str) -> None:
    assert page_key(page) == key


def test_volume_keys() -> None:
    assert volume_key("045") == "45"
    assert folder_volume("138-2") == "138"
    assert folder_volume("1-3") == "1"


def test_holds_volume_and_page(tmp_path: Path) -> None:
    manifest = write_index(
        tmp_path / "idx",
        {
            "a3d": {"138": {8: "0008-01", 20: "0020-01"}, "138-2": {2: "0002-01"}},
            "us": {"1": {5: "0005-01", 9: "0009-0010-01"}},
        },
    )
    index = CapIndex.load(manifest)
    assert index.holds_volume("a3d", "138") and index.holds_volume("a3d", "0138")
    assert not index.holds_volume("a3d", "139")
    assert index.folders["a3d"]["138"] == ["138", "138-2"]
    pages = PageIndex(tmp_path / "idx", index)
    assert pages.holds_page("a3d", "138", "8")
    assert pages.holds_page("a3d", "138", "2")  # in the second part
    assert not pages.holds_page("a3d", "138", "9")
    assert not pages.holds_page("a3d", "138", "5000")  # past the end of every part
    assert pages.holds_page("us", "1", "9")  # a long name: in the .multi
    assert not pages.holds_page("us", "1", "xxix")
    assert pages.missing == set()
    assert pages.lookup("a3d", "138", "2") == [Match("138-2", "0002-01")]
    assert pages.lookup("us", "1", "9") == [Match("1", "0009-0010-01")]
    assert pages.lookup("a3d", "138", "9") == []


def test_missing_bin_is_recorded(tmp_path: Path) -> None:
    manifest = write_index(tmp_path / "idx", {"a3d": {"138": {8: "0008-01"}}})
    (tmp_path / "idx" / "a3d" / "138.bin").unlink()
    pages = PageIndex(tmp_path / "idx", CapIndex.load(manifest))
    assert pages.lookup("a3d", "138", "8") is None
    assert not pages.holds_page("a3d", "138", "8")
    assert pages.missing == {("a3d", "138")}


def test_a_second_case_at_a_page(tmp_path: Path) -> None:
    manifest = write_index(tmp_path / "idx", {"a3d": {"138": {8: "0008-01"}}})
    (tmp_path / "idx" / "a3d" / "138.multi").write_text("8,0008-02\n")
    pages = PageIndex(tmp_path / "idx", CapIndex.load(manifest))
    assert pages.lookup("a3d", "138", "8") == [Match("138", "0008-01"), Match("138", "0008-02")]
