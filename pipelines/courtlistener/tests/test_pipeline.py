"""``stage``, ``text`` and ``records`` end to end on two tiny synthetic exports."""

import gzip
import io
import json
import sqlite3
from datetime import date
from pathlib import Path

import pytest
from exportkit import cite, cluster, court, docket, opinion, write_export, write_index

from stare_courtlistener import cli
from stare_courtlistener.records import compute_delta, first_seen_of
from stare_courtlistener.spool import TEXT_DB, spool_text

SEPT, DEC = date(2026, 9, 30), date(2026, 12, 31)
REGIONAL, SPECIALTY, NEUTRAL = 3, 4, 8


def _tables() -> dict[str, list[dict]]:
    """Clusters 1-7, one per class or edge, for the September export."""
    return {
        "courts": [court("pa", "Supreme Court of Pennsylvania", "S")],
        "opinion-clusters": [
            cluster(1, 101, "Blocked v. State", blocked="t"),
            cluster(2, 102, "Uncited v. State"),
            cluster(3, 103, "Held v. State"),
            cluster(4, 104, "Reprint v. State"),
            cluster(5, 105, "Smith v. Jones"),
            cluster(6, 106, "Sealed v. State"),
            cluster(7, 107, "Claims v. United States"),
        ],
        "citations": [
            cite(1, 1, "999", "A.3d", "1", REGIONAL),
            cite(2, 3, "138", "A.3d", "8", REGIONAL),
            cite(3, 4, "138", "A.3d", "500", REGIONAL),
            cite(4, 5, "245", "A.3d", "1012", REGIONAL),
            cite(5, 5, "2021", "Ohio", "5", NEUTRAL),
            cite(6, 6, "12", "F.4th", "3", 1),
            cite(7, 7, "10", "Ct. Cl.", "3", SPECIALTY),
        ],
        "dockets": [
            docket(104, "pa", "R-1"),
            docket(105, "pa", "J-12-2021"),
            docket(106, "pa", "S-1", blocked="t"),
            docket(999, "pa", "unrelated"),
        ],
        "opinions": [
            opinion(30, 3, "020lead", html_with_citations="<p>CAP has this one.</p>"),
            opinion(40, 4, "010combined", xml_harvard="<opinion><p>Reprinted.</p></opinion>"),
            opinion(
                51,
                5,
                "040dissent",
                author_str="Wecht",
                html_with_citations="<p>I dissent from <span class='citation'>"
                "<a href='/opinion/1/x/'>1 A.3d 1</a></span>.</p>",
            ),
            opinion(50, 5, "020lead", author_str="Saylor", html_lawbox="<p>We affirm.</p>"),
            opinion(60, 6, "020lead", plain_text="Sealed."),
        ],
    }


@pytest.fixture(name="index")
def index_fixture(tmp_path: Path) -> Path:
    return write_index(
        tmp_path / "idx",
        {"a3d": {"138": {8: "0008-01"}}, "us-ct-cl": {"10": {3: "0003-01"}}},
    )


def _run(*argv: str) -> str:
    out = io.StringIO()
    code = cli.main(list(argv), out=out)
    assert code == 0, out.getvalue()
    return out.getvalue()


def _classes(dest: Path, export: date) -> dict[int, str]:
    db = sqlite3.connect(dest / export.isoformat() / "stage.sqlite")
    try:
        return dict(db.execute("SELECT id, class FROM clusters"))
    finally:
        db.close()


def _manifest(out: Path, export: date) -> dict[int, dict]:
    path = out / "cl" / "exports" / export.isoformat() / "manifest.ndjson.gz"
    with gzip.open(path, "rt") as fh:
        return {(e := json.loads(line))["id"]: e for line in fh}


def test_stage_by_volume(tmp_path: Path, index: Path) -> None:
    write_export(tmp_path, SEPT, _tables())
    _run("stage", "--date", "2026-09-30", "--dest", str(tmp_path), "--index-manifest", str(index))
    assert _classes(tmp_path, SEPT) == {
        1: "blocked",
        2: "no_citation",
        3: "cap_held",
        4: "cap_held",  # the volume is CAP's, though the page isn't
        5: "selected",
        6: "docket_blocked",
        7: "cap_held",  # Ct. Cl. is CAP's U.S. Court of Claims by its short name
    }
    report = json.loads((tmp_path / "2026-09-30" / "stage-report.json").read_text())
    assert report["level"] == "volume"
    assert report["classes"]["selected"] == 1
    assert report["crosscheck_alnum_rule"]["held_only_by_this_mapping"] == 1
    assert report["crosscheck_alnum_rule"]["reporters_held_only_by_this_mapping"] == [
        ["Ct. Cl.", 1]
    ]
    db = sqlite3.connect(tmp_path / "2026-09-30" / "stage.sqlite")
    assert [d for (d,) in db.execute("SELECT id FROM dockets ORDER BY id")] == [105, 106]


def test_stage_by_page(tmp_path: Path, index: Path) -> None:
    write_export(tmp_path, SEPT, _tables())
    # the index dir's own manifest.json is enough, as in an index build directory
    out = _run(
        "stage", "--date", "2026-09-30", "--dest", str(tmp_path), "--index-dir", str(index.parent)
    )
    assert json.loads(out.splitlines()[0])["level"] == "page"
    classes = _classes(tmp_path, SEPT)
    assert classes[3] == "cap_held" and classes[7] == "cap_held"
    assert classes[4] == "selected"
    report = json.loads((tmp_path / "2026-09-30" / "stage-report.json").read_text())
    assert report["level"] == "page"
    assert report["selected"]["in_a_cap_volume_but_not_on_a_cap_page"] == 1
    assert (report["index_files_missing"], report["citations_judged_by_volume"]) == (0, 0)
    assert report["crosswalk"] == {"clusters": 2, "locations": 2, "with_case_file": 2}


def test_stage_by_page_with_a_volume_missing(tmp_path: Path, index: Path) -> None:
    (index.parent / "us-ct-cl" / "10.bin").unlink()
    write_export(tmp_path, SEPT, _tables())
    _run("stage", "--date", "2026-09-30", "--dest", str(tmp_path), "--index-dir", str(index.parent))
    assert _classes(tmp_path, SEPT)[7] == "cap_held"  # judged by its volume instead
    report = json.loads((tmp_path / "2026-09-30" / "stage-report.json").read_text())
    assert (report["index_files_missing"], report["citations_judged_by_volume"]) == (1, 1)
    assert report["crosswalk"]["with_case_file"] == 1


def test_stage_needs_an_index_manifest(tmp_path: Path) -> None:
    write_export(tmp_path, SEPT, _tables())
    code = cli.main(["stage", "--date", "2026-09-30", "--dest", str(tmp_path)], out=io.StringIO())
    assert code == 2


def _crosswalk(out: Path, export: date) -> dict[int, dict]:
    path = out / "cl" / "exports" / export.isoformat() / "crosswalk.ndjson.gz"
    with gzip.open(path, "rt") as fh:
        return {(e := json.loads(line))["cluster"]: e for line in fh}


def test_crosswalk_by_page(tmp_path: Path, index: Path) -> None:
    out = tmp_path / "out"
    write_export(tmp_path, SEPT, _tables())
    _run("stage", "--date", "2026-09-30", "--dest", str(tmp_path), "--index-dir", str(index.parent))
    _run("text", "--date", "2026-09-30", "--dest", str(tmp_path))
    _run(
        "records", "--date", "2026-09-30", "--dest", str(tmp_path), "--out", str(out), "--jobs", "1"
    )
    assert _crosswalk(out, SEPT) == {
        3: {
            "cluster": 3,
            "docket": 103,
            "opinions": [30],
            "cap": [
                {
                    "slug": "a3d",
                    "volume": "138",
                    "folder": "138",
                    "page": "8",
                    "case_file": "0008-01",
                }
            ],
        },
        7: {
            "cluster": 7,
            "docket": 107,
            "opinions": [],
            "cap": [
                {
                    "slug": "us-ct-cl",
                    "volume": "10",
                    "folder": "10",
                    "page": "3",
                    "case_file": "0003-01",
                }
            ],
        },
    }
    # cluster 6's docket is blocked: no record, no crosswalk line
    assert 6 not in _manifest(out, SEPT)
    report = json.loads((tmp_path / "2026-09-30" / "records-report.json").read_text())
    assert report["crosswalk"] == 2


def test_crosswalk_by_volume(tmp_path: Path, index: Path) -> None:
    out = tmp_path / "out"
    write_export(tmp_path, SEPT, _tables())
    _run("stage", "--date", "2026-09-30", "--dest", str(tmp_path), "--index-manifest", str(index))
    _run("text", "--date", "2026-09-30", "--dest", str(tmp_path))
    _run(
        "records", "--date", "2026-09-30", "--dest", str(tmp_path), "--out", str(out), "--jobs", "1"
    )
    crosswalk = _crosswalk(out, SEPT)
    assert sorted(crosswalk) == [3, 4, 7]
    assert crosswalk[4]["cap"] == [{"slug": "a3d", "volume": "138", "folder": "138", "page": "500"}]
    assert crosswalk[4]["opinions"] == [40]


def test_text_then_records_then_a_delta(tmp_path: Path, index: Path) -> None:
    out = tmp_path / "out"
    stage = ["--index-manifest", str(index), "--index-dir", str(index.parent)]
    write_export(tmp_path, SEPT, _tables())
    _run("stage", "--date", "2026-09-30", "--dest", str(tmp_path), *stage)
    _run("text", "--date", "2026-09-30", "--dest", str(tmp_path))
    _run(
        "records", "--date", "2026-09-30", "--dest", str(tmp_path), "--out", str(out), "--jobs", "1"
    )

    sept = _manifest(out, SEPT)
    assert sorted(sept) == [4, 5]
    assert {e["first_seen"] for e in sept.values()} == {"2026-09-30"}
    assert sept[5]["citations"][0] == {
        "cite": "245 A.3d 1012",
        "volume": "245",
        "reporter": "A.3d",
        "page": "1012",
        "type": 3,
        "slugs": ["a3d"],
    }
    record_file = out / "cl" / "c" / "5" / f"{sept[5]['hash']}.json.gz"
    record = json.loads(gzip.decompress(record_file.read_bytes()))
    assert [o["text"] for o in record["casebody"]["opinions"]] == [
        "We affirm.",
        "I dissent from 1 A.3d 1.",
    ]
    assert record["source"]["text_field"] == ["html_lawbox", "html_with_citations"]
    assert record["citations"][0] == {"type": "official", "cite": "245 A.3d 1012"}
    delta = json.loads((out / "cl" / "exports" / "2026-09-30" / "delta.json").read_text())
    assert (delta["added"], delta["changed"], delta["removed"]) == ([4, 5], [], [])
    assert delta["previous"] is None
    assert (out / "cl" / "exports" / "2026-09-30" / "export.json").exists() is False

    # December: 4 is now blocked, 5's majority is corrected, 8 is new.
    tables = _tables()
    tables["opinion-clusters"][3] = cluster(4, 104, "Reprint v. State", blocked="t")
    tables["opinion-clusters"].append(cluster(8, 108, "New v. Case", date_filed="2026-11-01"))
    tables["citations"].append(cite(8, 8, "50", "F.4th", "9", 1))
    tables["dockets"].append(docket(108, "pa", "N-1"))
    tables["opinions"][3] = opinion(
        50, 5, "020lead", author_str="Saylor", html_lawbox="<p>We affirm, as corrected.</p>"
    )
    tables["opinions"].append(opinion(80, 8, "010combined", html="<div>New.</div>"))
    write_export(tmp_path, DEC, tables)
    _run("stage", "--date", "2026-12-31", "--dest", str(tmp_path), *stage)
    _run("text", "--date", "2026-12-31", "--dest", str(tmp_path))
    previous = out / "cl" / "exports" / "2026-09-30"
    _run(
        "records",
        "--date",
        "2026-12-31",
        "--dest",
        str(tmp_path),
        "--out",
        str(out),
        "--previous",
        str(previous),
        "--jobs",
        "2",
    )
    dec = _manifest(out, DEC)
    assert sorted(dec) == [5, 8]
    assert dec[5]["first_seen"] == "2026-09-30"
    assert dec[8]["first_seen"] == "2026-12-31"
    assert dec[5]["hash"] != sept[5]["hash"]
    delta = json.loads((out / "cl" / "exports" / "2026-12-31" / "delta.json").read_text())
    assert (delta["added"], delta["changed"], delta["removed"]) == ([8], [5], [4])
    assert delta["previous"] == "2026-09-30"
    assert delta["counts"] == {"added": 1, "changed": 1, "removed": 1, "live": 2}
    # Both versions of 5 stay, each under its own hash.
    assert len(list((out / "cl" / "c" / "5").iterdir())) == 2


def test_unchanged_case_keeps_its_object(tmp_path: Path, index: Path) -> None:
    out = tmp_path / "out"
    for export in (SEPT, DEC):
        write_export(tmp_path, export, _tables())
        _run(
            "stage",
            "--date",
            export.isoformat(),
            "--dest",
            str(tmp_path),
            "--index-manifest",
            str(index),
        )
        _run("text", "--date", export.isoformat(), "--dest", str(tmp_path))
    _run(
        "records", "--date", "2026-09-30", "--dest", str(tmp_path), "--out", str(out), "--jobs", "1"
    )
    previous = out / "cl" / "exports" / "2026-09-30" / "manifest.ndjson.gz"
    _run(
        "records", "--date", "2026-12-31", "--dest", str(tmp_path), "--out", str(out),
        "--previous", str(previous), "--jobs", "1",
    )  # fmt: skip
    assert _manifest(out, SEPT)[5]["hash"] == _manifest(out, DEC)[5]["hash"]
    delta = json.loads((out / "cl" / "exports" / "2026-12-31" / "delta.json").read_text())
    assert (delta["added"], delta["changed"], delta["removed"]) == ([], [], [])
    assert len(list((out / "cl" / "c" / "5").iterdir())) == 1


def test_text_resumes(tmp_path: Path, index: Path) -> None:
    tables = _tables()
    tables["opinions"] += [
        opinion(500 + n, 5, "030concurrence", plain_text=f"C{n}.") for n in range(5)
    ]
    directory = write_export(tmp_path, SEPT, tables)
    _run("stage", "--date", "2026-09-30", "--dest", str(tmp_path), "--index-manifest", str(index))
    first = spool_text(directory, SEPT, stop_after=4)
    assert first["done"] == 0
    seen: list[int] = []
    second = spool_text(directory, SEPT, on_record=seen.append)
    assert second["records"] == len(tables["opinions"])
    assert second["kept"] == 7  # 50, 51 and 500-504
    db = sqlite3.connect(directory / TEXT_DB)
    assert db.execute("SELECT count(*) FROM opinions").fetchone()[0] == 7
    again = spool_text(directory, SEPT)
    assert again["done"] == 1


def test_compute_delta_and_first_seen() -> None:
    prev = {1: {"hash": "a", "first_seen": "2026-06-30"}, 2: {"hash": "b"}, 3: {"hash": "c"}}
    assert compute_delta({1: "a", 2: "x", 4: "d"}, prev) == {
        "added": [4],
        "changed": [2],
        "removed": [3],
    }
    assert compute_delta({2: "x", 1: "a"}, None) == {"added": [1, 2], "changed": [], "removed": []}
    seen = {1: "2026-06-30", 2: ""}
    assert first_seen_of(1, "2026-09-30", seen) == "2026-06-30"
    assert first_seen_of(2, "2026-09-30", seen) == "2026-09-30"
    assert first_seen_of(4, "2026-09-30", seen) == "2026-09-30"
    assert first_seen_of(1, "2026-09-30", None) == "2026-09-30"
