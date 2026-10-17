"""Which CAP reporter a CourtListener citation is in, citare's slugs for its reporter, and
CAP's names for courts' places.

CourtListener spells a reporter the way its citation reads (``So. 2d``, ``F. App’x``,
``Ohio C.C. (n.s.)``); CAP names each reporter it scanned by a slug (``so2d``) and a short
name (``So.2d``). The two are matched on lowercase letters and digits only, against both
the slug and the short name, after folding curly quotes. A short name CAP gives two
reporters (``Ct. Cl.`` is both the U.S. Court of Claims and West Virginia's) maps to both
slugs, and a citation in either counts as held.

Citations CourtListener types as LEXIS (6) or Westlaw (7) never map to a CAP reporter.
Otherwise the volume decides, not the type, since CourtListener's types are loose (``2004
Ohio 3319`` is typed as a state reporter, ``310 Neb. 1`` as neutral): a volume that is a
year maps only to the one CAP reporter numbered by year (``mass-app-div-annual``), and any
other volume to the rest. So ``2021 ND 123``, which folds to the same letters as ``N.D.``,
maps to nothing, and ``Mass. App. Div.`` picks its CAP series by volume.

``OVERRIDES`` maps a CourtListener reporter to slugs by hand where its spelling doesn't fold
to CAP's (``Serg. & Rawle`` for CAP's ``Serg. & Rawl.``, ``Ohio St. (N.S.)`` for ``Ohio
St.``); it wins over the folded match. Each entry was checked against the CAP reporter's
years and volume range.

The CAP table is packaged as ``data/cap_reporters.json`` (see ``scripts/cap_reporters.py``).

That match decides only whether CAP holds a case. The index files a citation under citare's
slug for its edition (citare#71): CAP's slug where CAP has the reporter, else one citare
derives from the edition name (``NY Slip Op`` → ``ny-slip-op``). A CourtListener reporter is
a reporters-db edition name, so ``edition_slugs`` looks it up in citare's own
``data/edition-slugs.json``, copied into ``data/`` from the citare tag stare builds with
(``scripts/edition_slugs.py``; stare's ``crates/stare/tests/edition_slugs.rs`` checks the
copy). A year-volume neutral citation shares its CAP reporter's slug (``2019-Ohio-1234`` and
``2021 ND 123`` are ``ohio`` and ``nd``, at volumes 2019 and 2021), so it needs no rule of its
own there. A name citare splits between reporters has several slugs (``Hill``: ``hill``,
``hill-sc``). The manifest records these; stare-admin checks them against citare when it
builds the index.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable
from functools import cache
from importlib.resources import files
from typing import Any

LEXIS, WEST, NEUTRAL = 6, 7, 8
UNMAPPED_TYPES = frozenset({LEXIS, WEST})
"""CourtListener citation types that are never a CAP reporter."""

OVERRIDES: dict[str, tuple[str, ...]] = {
    "D.C. App.": ("app-dc",),
    "Daly": ("daly-ny",),
    "Free. Ch.": ("freem-ch",),
    "Ill. Cir. Ct.": ("ill-cir-ct-rep",),
    "Mart.": ("mart-os",),
    "Mich. N.P.": ("mich-np-r",),
    "Morr. St. Cas.": ("mor-st-cas",),
    "Neb. Ct. App.": ("neb-app",),
    "Ohio St. (N.S.)": ("ohio-st",),
    "Patton & Heath": ("va-patt-heath",),
    "Serg. & Rawle": ("serg-rawl",),
    "Tiess.": ("teiss",),
    "Walk.": ("walker",),
}
"""CourtListener reporter → CAP slugs, where the spellings don't fold to the same letters."""


YEAR_VOLUME_SLUGS = frozenset({"mass-app-div-annual"})
"""CAP reporters whose volumes are years; no other CAP volume number reaches 1900."""


@cache
def _edition_slugs() -> dict[str, tuple[str, ...]]:
    text = files("stare_courtlistener").joinpath("data/edition-slugs.json").read_text("utf-8")
    return {name: tuple(slugs) for name, slugs in json.loads(text).items()}


def edition_slugs(reporter: str, cite_type: int | None = None) -> tuple[str, ...]:
    """citare's slugs for a CourtListener reporter; empty when citare has no such edition.

    The name is matched as written, then with curly quotes read as straight ones (``F.
    App’x``). LEXIS and Westlaw citations have none.
    """
    if cite_type in UNMAPPED_TYPES:
        return ()
    table = _edition_slugs()
    return table.get(reporter) or table.get(reporter.translate(_QUOTES), ())


def year_volume(volume: str | None) -> bool:
    """Whether a volume is a year (1900 to 2100), as a neutral citation's is."""
    text = (volume or "").strip()
    return text.isdigit() and 1900 <= int(text) <= 2100


_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"'})


def fold(text: str) -> str:
    """Lowercase letters and digits only: ``F. App’x`` → ``fappx``."""
    text = unicodedata.normalize("NFKC", text).translate(_QUOTES).lower()
    return re.sub(r"[^a-z0-9]", "", text)


@cache
def cap_reporters() -> list[dict[str, Any]]:
    """CAP's reporters: ``slug``, ``short_name`` and ``jurisdictions`` (long names)."""
    text = files("stare_courtlistener").joinpath("data/cap_reporters.json").read_text("utf-8")
    return json.loads(text)


class ReporterMap:
    """CourtListener ``(reporter, type)`` → the CAP slugs it may be."""

    def __init__(
        self,
        reporters: Iterable[dict[str, Any]] | None = None,
        overrides: dict[str, tuple[str, ...]] | None = None,
    ) -> None:
        self.by_key: dict[str, tuple[str, ...]] = {}
        found: dict[str, set[str]] = {}
        for reporter in cap_reporters() if reporters is None else reporters:
            for name in (reporter["slug"], reporter["short_name"]):
                found.setdefault(fold(name), set()).add(reporter["slug"])
        self.by_key = {key: tuple(sorted(slugs)) for key, slugs in found.items() if key}
        self.overrides = OVERRIDES if overrides is None else overrides

    def slugs(
        self, reporter: str, cite_type: int | None, volume: str | None = None
    ) -> tuple[str, ...]:
        """The CAP slugs a citation's reporter may be; empty when CAP never had it.

        Without a ``volume``, a neutral citation is taken to have a year for one.
        """
        if cite_type in UNMAPPED_TYPES:
            return ()
        year = year_volume(volume) if volume is not None else cite_type == NEUTRAL
        found = self.overrides.get(reporter) or self.by_key.get(fold(reporter), ())
        return tuple(s for s in found if (s in YEAR_VOLUME_SLUGS) == year)

    def ambiguous(self) -> dict[str, tuple[str, ...]]:
        """Folded names that more than one CAP reporter shares."""
        return {key: slugs for key, slugs in self.by_key.items() if len(slugs) > 1}


def alnum_slug(reporter: str, held_slugs: Iterable[str]) -> str | None:
    """The first sizing's rule, kept as a cross-check: the slug that folds like the reporter."""
    key = re.sub(r"[^a-z0-9]", "", reporter.lower())
    for slug in held_slugs:
        if re.sub(r"[^a-z0-9]", "", slug) == key:
            return slug
    return None


FEDERAL_JURISDICTIONS = frozenset({"F", "FD", "FB", "FBP", "FS"})
TRIBAL_JURISDICTIONS = frozenset({"TRS", "TRA", "TRT", "TRX"})


@cache
def _places() -> re.Pattern[str]:
    names = {j for r in cap_reporters() for j in r["jurisdictions"]}
    names -= {"Regional", "Tribal Jurisdictions"}
    ordered = sorted(names, key=len, reverse=True)
    return re.compile("|".join(re.escape(n) for n in ordered))


def jurisdiction_name(court_jurisdiction: str | None, court_name: str | None) -> str:
    """CAP's ``jurisdiction.name_long`` for a CourtListener court.

    Federal courts are ``United States`` and tribal courts ``Tribal Jurisdictions``, as in
    CAP. Any other court is the first CAP place named in its full name (``Court of Appeals
    of Ohio`` → ``Ohio``; ``West Virginia`` wins over ``Virginia``), or ``""`` when it
    names none.
    """
    code = (court_jurisdiction or "").upper()
    if code in FEDERAL_JURISDICTIONS:
        return "United States"
    name = court_name or ""
    if code in TRIBAL_JURISDICTIONS:
        return "Navajo Nation" if "Navajo" in name else "Tribal Jurisdictions"
    match = _places().search(name)
    return match.group(0) if match else ""
