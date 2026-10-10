"""One CourtListener cluster as a stare case record: CAP's ``CaseJson`` plus a ``source`` block.

The shape follows ``docs/plans/courtlistener-mirror.md`` ("The record"): the fields the
viewer reads from a CAP case (``crates/stare/src/case.rs``) filled from the cluster, its
docket and court, its citations and its opinions, and a ``source`` block saying where it
came from. ``record_hash`` is what the storage layout names the object by.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from stare_courtlistener.htmltext import to_text
from stare_courtlistener.reporters import LEXIS, NEUTRAL, WEST, jurisdiction_name, year_volume

SOURCE_NAME = "courtlistener"
SITE = "https://www.courtlistener.com"

OPINION_TYPES: dict[str, str] = {
    "010combined": "majority",
    "015unamimous": "unanimous",
    "020lead": "majority",
    "025plurality": "plurality",
    "030concurrence": "concurrence",
    "035concurrenceinpart": "concurring-in-part-and-dissenting-in-part",
    "040dissent": "dissent",
    "050addendum": "addendum",
    "060remittitur": "remittitur",
    "070rehearing": "rehearing",
    "080onthemerits": "on-the-merits",
    "090onmotiontostrike": "on-motion-to-strike-cost-bill",
    "100trialcourt": "majority",
}
"""CourtListener's opinion type → CAP's.

050 to 090 are CAP's own type names in CourtListener's numbering, so they map back one to
one; 020, 030, 035, 040 and 070 are confirmed against ``xml_harvard``'s ``<opinion
type=...>`` in the 2026-09-30 sample, and the others are not yet (the sample has none).
``010combined`` (every opinion of the case in one document, as most scraped opinions are)
and ``100trialcourt`` (the trial court's own opinion) have no CAP counterpart and are the
opinion of the court, so ``majority``. ``015unamimous`` is CourtListener's spelling.
"""
UNKNOWN_OPINION_TYPE = "majority"

TYPE_ORDER = {code: n for n, code in enumerate(OPINION_TYPES)}

FEDERAL, STATE, STATE_REGIONAL, SPECIALTY, SCOTUS_EARLY, JOURNAL = 1, 2, 3, 4, 5, 9
OFFICIAL_PRIORITY = (STATE, FEDERAL, SCOTUS_EARLY, SPECIALTY, STATE_REGIONAL)
"""CourtListener citation types that can be the official citation, best first."""
FEDERAL_OFFICIAL = ("U.S.",)
"""Among federal citations, reporters preferred as official (U.S. over S. Ct. and L. Ed.)."""

CITE_FORMATS: dict[str, str] = {
    "Ohio": "{volume}-Ohio-{page}",
    "NMSC": "{volume}-NMSC-{page}",
    "NMCA": "{volume}-NMCA-{page}",
    "NMCERT": "{volume}-NMCERT-{page}",
}
"""Neutral citations written with hyphens, not spaces, when the volume is a year."""


@dataclass(frozen=True)
class Cite:
    volume: str
    reporter: str
    page: str
    type: int | None

    @property
    def neutral(self) -> bool:
        """Typed neutral, or a hyphenated neutral form CourtListener typed as a reporter."""
        hyphenated = self.reporter in CITE_FORMATS and year_volume(self.volume)
        return self.type == NEUTRAL or hyphenated

    def text(self) -> str:
        fmt = CITE_FORMATS.get(self.reporter)
        if fmt and year_volume(self.volume):
            return fmt.format(volume=self.volume, page=self.page)
        return f"{self.volume} {self.reporter} {self.page}"


def cap_cite_type(cite: Cite, official: Cite | None) -> str:
    """CAP's type for a citation, given which one of the cluster's is official."""
    if cite.neutral:
        return "neutral"
    if cite.type in (LEXIS, WEST):
        return "vendor"
    return "official" if cite is official else "parallel"


def pick_official(cites: Sequence[Cite]) -> Cite | None:
    """The cluster's official citation: by ``OFFICIAL_PRIORITY``, then ``U.S.``, then order."""
    best: tuple[int, int, int] | None = None
    chosen = None
    for n, cite in enumerate(cites):
        if cite.type not in OFFICIAL_PRIORITY or cite.neutral:
            continue
        rank = (
            OFFICIAL_PRIORITY.index(cite.type),
            0 if cite.reporter in FEDERAL_OFFICIAL else 1,
            n,
        )
        if best is None or rank < best:
            best, chosen = rank, cite
    return chosen


def typed_citations(cites: Iterable[Cite]) -> list[dict[str, str]]:
    """The cluster's citations as CAP's ``[{"type", "cite"}]``, official first."""
    ordered = list(cites)
    official = pick_official(ordered)
    out = [{"type": cap_cite_type(c, official), "cite": c.text()} for c in ordered]
    rank = {"official": 0, "parallel": 1, "neutral": 2, "vendor": 3}
    return sorted(out, key=lambda c: rank[c["type"]])


@dataclass(frozen=True)
class Opinion:
    id: int
    type: str | None
    author: str | None
    text_field: str | None
    raw: str


def opinion_type(cl_type: str | None) -> str:
    return OPINION_TYPES.get(cl_type or "", UNKNOWN_OPINION_TYPE)


def _first(*values: str | None) -> str:
    for value in values:
        if value and value.strip():
            return value.strip()
    return ""


def build_record(
    cluster: dict[str, Any],
    docket: dict[str, Any] | None,
    court: dict[str, Any] | None,
    cites: Sequence[Cite],
    opinions: Sequence[Opinion],
    *,
    export: str,
    first_seen: str,
) -> dict[str, Any]:
    """The record for one cluster. Opinions with no text are left out."""
    docket = docket or {}
    court = court or {}
    ordered = sorted(opinions, key=lambda o: (TYPE_ORDER.get(o.type or "", 99), o.id))
    texts = [(o, to_text(o.raw, o.text_field)) for o in ordered]
    texts = [(o, t) for o, t in texts if t]
    fields = [o.text_field for o, _ in texts]
    name = _first(
        cluster.get("case_name_full"),
        cluster.get("case_name"),
        docket.get("case_name_full"),
        docket.get("case_name"),
        cluster.get("case_name_short"),
    )
    abbreviation = _first(
        cluster.get("case_name"),
        cluster.get("case_name_short"),
        docket.get("case_name"),
        docket.get("case_name_short"),
        name,
    )
    cluster_id = int(cluster["id"])
    slug = _first(cluster.get("slug")) or "case"
    source: dict[str, Any] = {
        "name": SOURCE_NAME,
        "export": export,
        "first_seen": first_seen,
        "ids": {
            "cluster": cluster_id,
            "docket": cluster.get("docket_id"),
            "opinions": [o.id for o, _ in texts],
        },
        "court_id": docket.get("court_id"),
        "docket_number": docket.get("docket_number") or None,
        "precedential_status": cluster.get("precedential_status") or None,
        "text_field": fields[0] if len(set(fields)) == 1 else fields,
        "url": f"{SITE}/opinion/{cluster_id}/{slug}/",
    }
    if cluster.get("date_approximate"):
        source["date_is_approximate"] = True
    return {
        "id": cluster_id,
        "name": name,
        "name_abbreviation": abbreviation,
        "decision_date": cluster.get("date_filed") or "",
        "citations": typed_citations(cites),
        "court": {"name": court.get("full_name") or ""},
        "jurisdiction": {
            "name_long": jurisdiction_name(court.get("jurisdiction"), court.get("full_name"))
        },
        "casebody": {
            "opinions": [
                {"type": opinion_type(o.type), "author": o.author or None, "text": t}
                for o, t in texts
            ]
        },
        "source": source,
    }


VOLATILE_SOURCE_KEYS = ("export", "first_seen")
"""``source`` keys left out of the hash, so an unchanged case hashes the same in every export."""


def canonical_json(record: dict[str, Any]) -> bytes:
    """The record as hashed: sorted keys, no whitespace, UTF-8, minus the volatile keys."""
    source = {k: v for k, v in record.get("source", {}).items() if k not in VOLATILE_SOURCE_KEYS}
    body = {**record, "source": source}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def record_hash(record: dict[str, Any]) -> str:
    """The first 16 hex digits of the SHA-256 of the record's canonical JSON."""
    return hashlib.sha256(canonical_json(record)).hexdigest()[:16]


def record_bytes(record: dict[str, Any]) -> bytes:
    """The stored object: the whole record as JSON, gzipped with no name or timestamp."""
    text = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return gzip.compress(text.encode("utf-8"), compresslevel=9, mtime=0)
