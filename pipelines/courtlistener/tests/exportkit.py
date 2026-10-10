"""Tiny synthetic exports for the stage/text/records tests.

Each table is written as ``<table>-<date>.csv`` in the export's own CSV form (every
non-null value quoted, ``\\"`` and ``\\\\`` escapes, null as an empty unquoted field), with
the real export's full header so the readers see the same columns they would in a real one.
"""

from __future__ import annotations

import json
import struct
from datetime import date
from pathlib import Path
from typing import Any

HEADERS = {
    "courts": (
        "id,pacer_court_id,pacer_has_rss_feed,pacer_rss_entry_types,date_last_pacer_contact,"
        "fjc_court_id,date_modified,in_use,has_opinion_scraper,has_oral_argument_scraper,"
        "position,citation_string,short_name,full_name,url,start_date,end_date,jurisdiction,"
        "notes,parent_court_id"
    ),
    "opinion-clusters": (
        "id,date_created,date_modified,judges,date_filed,date_filed_is_approximate,slug,"
        "case_name_short,case_name,case_name_full,scdb_id,scdb_decision_direction,"
        "scdb_votes_majority,scdb_votes_minority,source,procedural_history,attorneys,"
        "nature_of_suit,posture,syllabus,headnotes,summary,disposition,history,other_dates,"
        "cross_reference,correction,citation_count,precedential_status,date_blocked,blocked,"
        "filepath_json_harvard,filepath_pdf_harvard,docket_id,arguments,headmatter"
    ),
    "citations": "id,volume,reporter,page,type,cluster_id,date_created,date_modified",
    "dockets": (
        "id,date_created,date_modified,source,appeal_from_str,assigned_to_str,referred_to_str,"
        "panel_str,date_last_index,date_cert_granted,date_cert_denied,date_argued,"
        "date_reargued,date_reargument_denied,date_filed,date_terminated,date_last_filing,"
        "case_name_short,case_name,case_name_full,slug,docket_number,docket_number_core,"
        "pacer_case_id,cause,nature_of_suit,jury_demand,jurisdiction_type,"
        "appellate_fee_status,appellate_case_type_information,mdl_status,filepath_local,"
        "filepath_ia,filepath_ia_json,ia_upload_failure_count,ia_needs_upload,"
        "ia_date_first_change,view_count,date_blocked,blocked,appeal_from_id,assigned_to_id,"
        "court_id,idb_data_id,originating_court_information_id,referred_to_id,"
        "federal_dn_case_type,federal_dn_office_code,federal_dn_judge_initials_assigned,"
        "federal_dn_judge_initials_referred,federal_defendant_number,parent_docket_id,"
        "docket_number_raw,docket_number_source"
    ),
    "opinions": (
        "id,date_created,date_modified,author_str,per_curiam,joined_by_str,type,sha1,"
        "page_count,download_url,local_path,plain_text,html,html_lawbox,html_columbia,"
        "html_anon_2020,xml_harvard,xml_scan,html_with_citations,extracted_by_ocr,author_id,"
        "cluster_id"
    ),
}


def _field(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_table(directory: Path, table: str, export: date, rows: list[dict[str, Any]]) -> Path:
    """Write ``rows`` (column → value; missing columns are null) as one table's CSV."""
    header = HEADERS[table].split(",")
    path = directory / f"{table}-{export.isoformat()}.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(",".join(header) + "\n")
        for row in rows:
            if unknown := set(row) - set(header):
                raise KeyError(f"{table} has no column {unknown}")
            fh.write(",".join(_field(row.get(c)) for c in header) + "\n")
    return path


def court(id_: str, full_name: str, jurisdiction: str) -> dict[str, Any]:
    return {
        "id": id_,
        "full_name": full_name,
        "short_name": full_name,
        "jurisdiction": jurisdiction,
    }


def cluster(id_: int, docket_id: int, name: str, **extra: Any) -> dict[str, Any]:
    row = {
        "id": id_,
        "docket_id": docket_id,
        "date_filed": "2021-04-02",
        "date_filed_is_approximate": "f",
        "slug": name.lower().replace(" ", "-").replace(".", ""),
        "case_name_short": name.split(" v. ")[0],
        "case_name": name,
        "case_name_full": "",
        "precedential_status": "Published",
        "blocked": "f",
        "filepath_json_harvard": "",
        "date_modified": "2026-01-01 00:00:00+00",
    }
    row.update(extra)
    return row


def cite(id_: int, cluster_id: int, volume: str, reporter: str, page: str, type_: int) -> dict:
    return {
        "id": id_,
        "cluster_id": cluster_id,
        "volume": volume,
        "reporter": reporter,
        "page": page,
        "type": type_,
    }


def docket(id_: int, court_id: str, number: str, blocked: str = "f") -> dict[str, Any]:
    return {"id": id_, "court_id": court_id, "docket_number": number, "blocked": blocked}


def opinion(id_: int, cluster_id: int, type_: str, **fields: Any) -> dict[str, Any]:
    row = {"id": id_, "cluster_id": cluster_id, "type": type_, "per_curiam": "f"}
    row.update(fields)
    return row


def write_export(directory: Path, export: date, tables: dict[str, list[dict[str, Any]]]) -> Path:
    """Write every table into ``directory/<date>/`` and return that directory."""
    target = directory / export.isoformat()
    target.mkdir(parents=True, exist_ok=True)
    for table, rows in tables.items():
        write_table(target, table, export, rows)
    return target


def write_index(root: Path, volumes: dict[str, dict[str, dict[int, str]]]) -> Path:
    """A CAP index version: ``slug → folder → {page: case file}``, plus its manifest.json.

    A page whose case file name is 7 bytes or longer goes in the ``.multi`` (with ``*`` in
    the ``.bin``), as the real index does.
    """
    root.mkdir(parents=True, exist_ok=True)
    reporters: dict[str, list[str]] = {}
    for slug, folders in volumes.items():
        (root / slug).mkdir(exist_ok=True)
        reporters[slug] = sorted(folders)
        for folder, pages in folders.items():
            size = (max(pages, default=0) + 1) * 8
            data = bytearray(size)
            multi = []
            for page, name in pages.items():
                entry = name if len(name) < 8 else "*"
                if entry == "*":
                    multi.append(f"{page},{name}")
                struct.pack_into("8s", data, page * 8, entry.encode())
            (root / slug / f"{folder}.bin").write_bytes(bytes(data))
            if multi:
                (root / slug / f"{folder}.multi").write_text("\n".join(multi) + "\n")
    manifest = {"format": 2, "version": "vtest", "base": "v/vtest/", "reporters": reporters}
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest))
    return path
