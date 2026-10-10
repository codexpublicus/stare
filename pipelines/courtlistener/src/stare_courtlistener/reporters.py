"""Which CAP reporter a CourtListener citation is in, and CAP's names for courts' places.

CourtListener spells a reporter the way its citation reads (``So. 2d``, ``F. App’x``,
``Ohio C.C. (n.s.)``); CAP names each reporter it scanned by a slug (``so2d``) and a short
name (``So.2d``). The two are matched on lowercase letters and digits only, against both
the slug and the short name, after folding curly quotes. A short name CAP gives two
reporters (``Ct. Cl.`` is both the U.S. Court of Claims and West Virginia's) maps to both
slugs, and a citation in either counts as held.

Citations CourtListener types as LEXIS (6), Westlaw (7) or neutral (8) never map to a CAP
reporter, though some spell like one: the neutral ``2021 ND 123`` folds to the same
letters as ``N.D.``, and ``2021-Ohio-1234`` is typed ``Ohio`` like the Ohio Reports.

``OVERRIDES`` maps a CourtListener reporter to slugs by hand where the folding gets it
wrong; it wins over the folded match.

The CAP table is packaged as ``data/cap_reporters.json`` (see ``scripts/cap_reporters.py``).
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
UNMAPPED_TYPES = frozenset({LEXIS, WEST, NEUTRAL})
"""CourtListener citation types that are never a CAP reporter."""

OVERRIDES: dict[str, tuple[str, ...]] = {}
"""CourtListener reporter → CAP slugs, where the folded match is wrong. None needed so far."""

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

    def slugs(self, reporter: str, cite_type: int | None) -> tuple[str, ...]:
        """The CAP slugs a citation's reporter may be; empty when CAP never had it."""
        if cite_type in UNMAPPED_TYPES:
            return ()
        if reporter in self.overrides:
            return self.overrides[reporter]
        return self.by_key.get(fold(reporter), ())

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
