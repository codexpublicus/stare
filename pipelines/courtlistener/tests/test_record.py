"""The record's shape, the CourtListener→CAP mappings, and the hash."""

import gzip
import json

import pytest

from stare_courtlistener.record import (
    OPINION_TYPES,
    Cite,
    Opinion,
    build_record,
    canonical_json,
    opinion_type,
    record_bytes,
    record_hash,
    typed_citations,
)

FEDERAL, STATE, REGIONAL, LEXIS, WEST, NEUTRAL = 1, 2, 3, 6, 7, 8

CLUSTER = {
    "id": 9876543,
    "docket_id": 6543210,
    "date_filed": "2021-04-02",
    "date_approximate": 0,
    "case_name_short": "Smith",
    "case_name": "Smith v. Jones",
    "case_name_full": "",
    "slug": "smith-v-jones",
    "precedential_status": "Published",
}
DOCKET = {"id": 6543210, "court_id": "pa", "docket_number": "J-12-2021"}
COURT = {"id": "pa", "full_name": "Supreme Court of Pennsylvania", "jurisdiction": "S"}


def _record(**kwargs) -> dict:
    opinions = kwargs.pop(
        "opinions",
        [
            Opinion(11112, "040dissent", "Wecht", "html_with_citations", "<p>I dissent.</p>"),
            Opinion(11111, "020lead", "Saylor", "html_with_citations", "<p>We affirm.</p>"),
        ],
    )
    cites = kwargs.pop("cites", [Cite("245", "A.3d", "1012", REGIONAL)])
    return build_record(
        kwargs.pop("cluster", CLUSTER),
        DOCKET,
        COURT,
        cites,
        opinions,
        export=kwargs.pop("export", "2026-09-30"),
        first_seen=kwargs.pop("first_seen", "2026-09-30"),
    )


def test_record_matches_the_design() -> None:
    record = _record()
    assert record == {
        "id": 9876543,
        "name": "Smith v. Jones",
        "name_abbreviation": "Smith v. Jones",
        "decision_date": "2021-04-02",
        "citations": [{"type": "official", "cite": "245 A.3d 1012"}],
        "court": {"name": "Supreme Court of Pennsylvania"},
        "jurisdiction": {"name_long": "Pennsylvania"},
        "casebody": {
            "opinions": [
                {"type": "majority", "author": "Saylor", "text": "We affirm."},
                {"type": "dissent", "author": "Wecht", "text": "I dissent."},
            ]
        },
        "source": {
            "name": "courtlistener",
            "export": "2026-09-30",
            "first_seen": "2026-09-30",
            "ids": {"cluster": 9876543, "docket": 6543210, "opinions": [11111, 11112]},
            "court_id": "pa",
            "docket_number": "J-12-2021",
            "precedential_status": "Published",
            "text_field": "html_with_citations",
            "url": "https://www.courtlistener.com/opinion/9876543/smith-v-jones/",
        },
    }


def test_empty_opinions_are_left_out_and_mixed_fields_listed() -> None:
    record = _record(
        opinions=[
            Opinion(1, "020lead", None, "html_lawbox", "<p>Text.</p>"),
            Opinion(2, "030concurrence", "", "plain_text", "Agreed."),
            Opinion(3, "040dissent", "X", None, ""),
        ]
    )
    assert [o["type"] for o in record["casebody"]["opinions"]] == ["majority", "concurrence"]
    assert record["casebody"]["opinions"][1]["author"] is None
    assert record["source"]["text_field"] == ["html_lawbox", "plain_text"]
    assert record["source"]["ids"]["opinions"] == [1, 2]


@pytest.mark.parametrize(
    ("cl", "cap"),
    [
        ("010combined", "majority"),
        ("020lead", "majority"),
        ("025plurality", "plurality"),
        ("030concurrence", "concurrence"),
        ("035concurrenceinpart", "concurring-in-part-and-dissenting-in-part"),
        ("040dissent", "dissent"),
        ("070rehearing", "rehearing"),
        ("090onmotiontostrike", "on-motion-to-strike-cost-bill"),
        ("100trialcourt", "majority"),
        ("999new", "majority"),
        (None, "majority"),
    ],
)
def test_opinion_types(cl: str | None, cap: str) -> None:
    assert opinion_type(cl) == cap


def test_every_cl_type_maps() -> None:
    assert len(OPINION_TYPES) == 13
    assert all(OPINION_TYPES.values())


def test_citation_types() -> None:
    cites = [
        Cite("2021", "WL", "123456", WEST),
        Cite("245", "A.3d", "1012", REGIONAL),
        Cite("2021", "Ohio", "1234", NEUTRAL),
        Cite("665", "Pa.", "1", STATE),
        Cite("2021", "Pa. LEXIS", "77", LEXIS),
    ]
    assert typed_citations(cites) == [
        {"type": "official", "cite": "665 Pa. 1"},
        {"type": "parallel", "cite": "245 A.3d 1012"},
        {"type": "neutral", "cite": "2021-Ohio-1234"},
        {"type": "vendor", "cite": "2021 WL 123456"},
        {"type": "vendor", "cite": "2021 Pa. LEXIS 77"},
    ]


def test_us_reports_are_official_over_other_federal_reporters() -> None:
    cites = [
        Cite("141", "S. Ct.", "1", FEDERAL),
        Cite("593", "U.S.", "1", FEDERAL),
        Cite("209", "L. Ed. 2d", "1", FEDERAL),
    ]
    assert typed_citations(cites)[0] == {"type": "official", "cite": "593 U.S. 1"}


def test_only_neutral_means_no_official() -> None:
    assert typed_citations([Cite("2021", "ND", "7", NEUTRAL)]) == [
        {"type": "neutral", "cite": "2021 ND 7"}
    ]


def test_hash_ignores_export_and_first_seen() -> None:
    first = _record(export="2026-09-30", first_seen="2026-09-30")
    later = _record(export="2026-12-31", first_seen="2026-06-30")
    assert record_hash(first) == record_hash(later)
    assert len(record_hash(first)) == 16


def test_hash_ignores_key_order() -> None:
    record = _record()
    shuffled = json.loads(json.dumps(record, sort_keys=True))
    reordered = dict(reversed(list(shuffled.items())))
    assert record_hash(reordered) == record_hash(record)
    assert canonical_json(reordered) == canonical_json(record)


def test_hash_is_pinned() -> None:
    # A change here changes every record's object name: that's a new export of everything.
    assert record_hash(_record()) == "569c4004fc360676"


def test_hash_changes_with_content() -> None:
    base = record_hash(_record())
    edited = _record(
        opinions=[Opinion(11111, "020lead", "Saylor", "html_with_citations", "<p>We reverse.</p>")]
    )
    assert record_hash(edited) != base
    renamed = _record(cluster={**CLUSTER, "case_name": "Smith v. Jonas"})
    assert record_hash(renamed) != base


def test_stored_bytes_are_deterministic() -> None:
    record = _record()
    assert record_bytes(record) == record_bytes(json.loads(json.dumps(record)))
    assert json.loads(gzip.decompress(record_bytes(record))) == record
