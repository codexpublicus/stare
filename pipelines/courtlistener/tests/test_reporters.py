"""CourtListener reporter spellings to CAP slugs, and court names to CAP's jurisdictions."""

import pytest

from stare_courtlistener.reporters import ReporterMap, alnum_slug, fold, jurisdiction_name

STATE, REGIONAL, SPECIALTY, WEST, NEUTRAL = 2, 3, 4, 7, 8


@pytest.fixture(scope="module", name="reporters")
def reporters_fixture() -> ReporterMap:
    return ReporterMap()


def test_fold() -> None:
    assert fold("F. App’x") == fold("F. App'x") == "fappx"
    assert fold("Ohio C.C. (n.s.)") == "ohioccns"


@pytest.mark.parametrize(
    ("reporter", "type_", "slugs"),
    [
        ("So. 2d", REGIONAL, ("so2d",)),  # CAP's short name is So.2d
        ("N.Y.2d", STATE, ("ny-2d",)),
        ("F. App’x", 1, ("f-appx",)),
        ("Ohio C.C. (n.s.)", STATE, ("ohio-cc-ns",)),
        ("A.3d", REGIONAL, ("a3d",)),
        ("Ohio", STATE, ("ohio",)),  # the Ohio Reports
        ("Ohio", NEUTRAL, ()),  # 2021-Ohio-1234
        ("ND", NEUTRAL, ()),  # 2021 ND 123 folds like N.D.
        ("WL", WEST, ()),
        ("Ct. Cl.", SPECIALTY, ("us-ct-cl", "wv-ct-cl")),  # CAP has two
        ("NY Slip Op", STATE, ()),
        ("F.4th", 1, ()),
    ],
)
def test_slugs(reporters: ReporterMap, reporter: str, type_: int, slugs: tuple) -> None:
    assert reporters.slugs(reporter, type_) == slugs


def test_only_known_ambiguities(reporters: ReporterMap) -> None:
    assert reporters.ambiguous() == {
        "ctcl": ("us-ct-cl", "wv-ct-cl"),
        "massappdiv": ("mass-app-div", "mass-app-div-annual"),
    }


@pytest.mark.parametrize(
    ("reporter", "type_", "volume", "slugs"),
    [
        ("ND", NEUTRAL, "2021", ()),
        ("Ohio", NEUTRAL, "1995", ()),
        ("Neb.", NEUTRAL, "310", ("neb",)),  # a mistyped reporter citation
        ("M.J.", NEUTRAL, "62", ("mj",)),
        ("Neb.", STATE, "310", ("neb",)),
        ("Ohio", STATE, "2004", ()),  # 2004-Ohio-3319, typed as a state reporter
        ("Ohio", STATE, "5", ("ohio",)),
        ("Mass. App. Div.", STATE, "2005", ("mass-app-div-annual",)),
        ("Mass. App. Div.", STATE, "30", ("mass-app-div",)),
    ],
)
def test_neutral_by_volume(
    reporters: ReporterMap, reporter: str, type_: int, volume: str, slugs: tuple
) -> None:
    assert reporters.slugs(reporter, type_, volume) == slugs


@pytest.mark.parametrize(
    ("reporter", "slug"),
    [("Ohio St. (N.S.)", "ohio-st"), ("Serg. & Rawle", "serg-rawl"), ("Daly", "daly-ny")],
)
def test_packaged_overrides(reporters: ReporterMap, reporter: str, slug: str) -> None:
    assert reporters.slugs(reporter, STATE) == (slug,)


def test_overrides_name_real_slugs(reporters: ReporterMap) -> None:
    known = {s for slugs in reporters.by_key.values() for s in slugs}
    assert {s for slugs in reporters.overrides.values() for s in slugs} <= known


def test_overrides_win() -> None:
    mapped = ReporterMap(overrides={"Odd Rptr.": ("a2d",)})
    assert mapped.slugs("Odd Rptr.", STATE) == ("a2d",)


def test_alnum_rule_crosscheck() -> None:
    assert alnum_slug("So. 2d", ["so2d", "a2d"]) == "so2d"
    assert alnum_slug("Ct. Cl.", ["us-ct-cl"]) is None
    assert alnum_slug("ND", ["nd"]) == "nd"


@pytest.mark.parametrize(
    ("code", "name", "expected"),
    [
        ("F", "Court of Appeals for the Ninth Circuit", "United States"),
        ("FD", "District Court, District of Columbia", "United States"),
        ("S", "Supreme Court of North Carolina", "North Carolina"),
        ("SA", "Court of Appeals of Ohio", "Ohio"),
        ("S", "West Virginia Supreme Court", "West Virginia"),
        ("SA", "Court of Appeals of Arkansas", "Arkansas"),
        ("S", "District of Columbia Court of Appeals", "District of Columbia"),
        ("TRS", "Navajo Nation Supreme Court", "Navajo Nation"),
        ("TRA", "Some Tribal Court of Appeals", "Tribal Jurisdictions"),
        ("SAG", "Minnesota Attorney General Reports", "Minnesota"),
        ("I", "International Court", ""),
    ],
)
def test_jurisdiction_name(code: str, name: str, expected: str) -> None:
    assert jurisdiction_name(code, name) == expected
