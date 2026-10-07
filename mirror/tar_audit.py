#!/usr/bin/env python3
"""Audit the CAP mirror's tars against their published .tar.sha256 files (#77).

Stdlib only, so it runs in a bare python:3.12-alpine container. Subcommands:

  audit    hash every <reporter>/<volume>.tar under --root and compare it to <volume>.tar.sha256;
           appends one JSON line per file to --out and skips files already recorded there
  summary  counts per status, totals, and every non-ok record from --out
  inspect  for each non-ok volume, test its .zip (zipfile.testzip) and check its .tar.csv
           against the tar's size; needs the mirror, no network
  head     HTTP HEAD each non-ok tar on static.case.law and compare Content-Length; needs
           network, not the mirror

Statuses: ok, mismatch, missing_tar (a .sha256 with no tar), missing_sha (a tar with no
.sha256; it is still hashed), bad_sha (the .sha256 doesn't parse), unreadable (an OSError while
reading; retried on the next run).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import hashlib
import json
import os
import re
import sys
import time
import zipfile
import zlib
from pathlib import Path

BUF_SIZE = 16 * 1024 * 1024
HEX64 = re.compile(r"\b([0-9a-fA-F]{64})\b")
STATUSES = ("ok", "mismatch", "missing_tar", "missing_sha", "bad_sha", "unreadable")
RETRY_STATUSES = {"unreadable"}
SOURCE_URL = "https://static.case.law"


def parse_sha256(text: str) -> str | None:
    """Return the digest from a .tar.sha256 file.

    The mirror's files are a bare 64-character hex digest with no newline; this also accepts
    the `sha256sum` form (`<digest>  <name>`).
    """
    m = HEX64.search(text)
    return m.group(1).lower() if m else None


def hash_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    buf = bytearray(BUF_SIZE)
    view = memoryview(buf)
    n = 0
    with open(path, "rb", buffering=0) as f:
        while True:
            k = f.readinto(buf)
            if not k:
                break
            h.update(view[:k])
            n += k
    return h.hexdigest(), n


def scan(root: Path) -> list[dict]:
    """List every volume that has a .tar or a .tar.sha256, sorted by reporter and volume."""
    items = []
    for reporter in sorted(e.name for e in os.scandir(root) if e.is_dir()):
        tars: dict[str, int] = {}
        mtimes: dict[str, float] = {}
        shas: set[str] = set()
        for e in os.scandir(root / reporter):
            if e.name.endswith(".tar.sha256"):
                shas.add(e.name[: -len(".tar.sha256")])
            elif e.name.endswith(".tar"):
                st = e.stat()
                tars[e.name[: -len(".tar")]] = st.st_size
                mtimes[e.name[: -len(".tar")]] = st.st_mtime
        for vol in sorted(tars.keys() | shas, key=lambda v: (len(v), v)):
            items.append(
                {
                    "path": f"{reporter}/{vol}.tar",
                    "has_tar": vol in tars,
                    "has_sha": vol in shas,
                    "size": tars.get(vol),
                    "mtime": mtimes.get(vol),
                }
            )
    return items


def check(root: Path, item: dict) -> dict:
    tar = root / item["path"]
    rec = {
        "path": item["path"],
        "size": item["size"],
        "mtime": item["mtime"],
        "expected": None,
        "actual": None,
        "status": None,
        "seconds": 0.0,
    }
    if item["has_sha"]:
        try:
            raw = (root / (item["path"] + ".sha256")).read_text(errors="replace")
        except OSError as e:
            rec.update(status="unreadable", error=f"sha256: {e}")
            return rec
        rec["expected"] = parse_sha256(raw)
        if rec["expected"] is None:
            rec["sha_raw"] = raw[:200]
    if not item["has_tar"]:
        rec["status"] = "missing_tar"
        return rec
    t0 = time.monotonic()
    try:
        rec["actual"], n = hash_file(tar)
    except OSError as e:
        rec.update(status="unreadable", error=str(e), seconds=round(time.monotonic() - t0, 3))
        return rec
    rec["seconds"] = round(time.monotonic() - t0, 3)
    if n != item["size"]:
        rec["read_bytes"] = n
    if not item["has_sha"]:
        rec["status"] = "missing_sha"
    elif rec["expected"] is None:
        rec["status"] = "bad_sha"
    else:
        rec["status"] = "ok" if rec["actual"] == rec["expected"] else "mismatch"
    return rec


def load(out: Path) -> dict[str, dict]:
    """Last record per path from the JSONL file (a later line supersedes an earlier one)."""
    recs: dict[str, dict] = {}
    if out.exists():
        with open(out) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a line torn by a crash; that file is redone
                recs[r["path"]] = r
    return recs


def fmt_dur(s: float) -> str:
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m{s % 60:02d}s"


def cmd_audit(a: argparse.Namespace) -> int:
    root, out = Path(a.root), Path(a.out)
    jobs = max(1, min(a.jobs, 4))
    t_scan = time.monotonic()
    items = scan(root)
    if a.reporter:
        items = [i for i in items if i["path"].split("/", 1)[0] in set(a.reporter)]
    if a.path:
        items = [i for i in items if i["path"] in set(a.path)]
    done = {p for p, r in load(out).items() if r["status"] not in RETRY_STATUSES}
    todo = [i for i in items if i["path"] not in done]
    n_skip = len(items) - len(todo)
    if a.limit:
        todo = todo[: a.limit]
    total_bytes = sum(i["size"] or 0 for i in todo)
    print(
        f"scanned {len(items)} volumes in {time.monotonic() - t_scan:.1f}s; "
        f"{n_skip} already done, {len(todo)} to do, "
        f"{total_bytes / 1e12:.3f} TB, {jobs} jobs",
        flush=True,
    )
    t0 = last = time.monotonic()
    n_done = bytes_done = 0
    counts: dict[str, int] = {}
    with open(out, "a") as f, cf.ThreadPoolExecutor(jobs) as ex:
        it = iter(todo)
        pending = set()
        for item in it:  # keep the queue short so a kill loses little work
            pending.add(ex.submit(check, root, item))
            if len(pending) >= jobs * 2:
                break
        while pending:
            finished, pending = cf.wait(pending, return_when=cf.FIRST_COMPLETED)
            for fut in finished:
                rec = fut.result()
                f.write(json.dumps(rec, separators=(",", ":")) + "\n")
                f.flush()
                os.fsync(f.fileno())
                n_done += 1
                bytes_done += rec["size"] or 0
                counts[rec["status"]] = counts.get(rec["status"], 0) + 1
                if rec["status"] != "ok":
                    print(f"  {rec['status']}: {rec['path']}", flush=True)
                nxt = next(it, None)
                if nxt is not None:
                    pending.add(ex.submit(check, root, nxt))
            now = time.monotonic()
            if now - last >= a.every or not pending:
                last = now
                el = now - t0
                rate = bytes_done / el if el else 0
                eta = (total_bytes - bytes_done) / rate if rate else 0
                print(
                    f"[{fmt_dur(el)}] {n_done}/{len(todo)} files, "
                    f"{bytes_done / 1e9:.1f}/{total_bytes / 1e9:.1f} GB, "
                    f"{rate / 1e6:.0f} MB/s, ETA {fmt_dur(eta)}, "
                    + " ".join(f"{k}={v}" for k, v in sorted(counts.items())),
                    flush=True,
                )
    return 0


def cmd_summary(a: argparse.Namespace) -> int:
    recs = load(Path(a.out))
    counts = {s: 0 for s in STATUSES}
    for r in recs.values():
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    tbytes = sum(r["size"] or 0 for r in recs.values())
    tsec = sum(r["seconds"] for r in recs.values())
    bad = sorted((r for r in recs.values() if r["status"] != "ok"), key=lambda r: r["path"])
    if a.json:
        json.dump(
            {"counts": counts, "files": len(recs), "bytes": tbytes, "hash_seconds": tsec, "non_ok": bad},
            sys.stdout,
            indent=1,
        )
        print()
        return 0
    print(f"{len(recs)} records, {tbytes:,} bytes, {fmt_dur(tsec)} summed hash time")
    for s, n in counts.items():
        print(f"  {s}: {n}")
    for r in bad:
        print(f"{r['status']}\t{r['path']}\t{r['size']}\t{r['expected']}\t{r['actual']}")
    return 0


def csv_extent(path: Path) -> tuple[int, int]:
    """(entries, implied tar length) from a .tar.csv: the end of the last member's data,
    rounded up to a 512-byte block, plus the two zero blocks that end a tar."""
    end = n = 0
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            n += 1
            off, size = int(row["offset"]), int(row["size"])
            end = max(end, off + -(-size // 512) * 512)
    return n, end + 1024


def cmd_inspect(a: argparse.Namespace) -> int:
    root = Path(a.root)
    bad = [r for r in load(Path(a.out)).values() if r["status"] not in ("ok",)]
    for r in sorted(bad, key=lambda r: r["path"]):
        base = root / r["path"][: -len(".tar")]
        res = {"path": r["path"], "status": r["status"], "size": r["size"]}
        z = base.with_suffix(".zip")
        try:
            with zipfile.ZipFile(z) as zf:
                res["zip_entries"] = len(zf.infolist())
                res["zip_testzip"] = zf.testzip() or "ok"
        except FileNotFoundError:
            res["zip_testzip"] = "missing"
        except (zipfile.BadZipFile, zlib.error, OSError, EOFError, RuntimeError, NotImplementedError) as e:
            res["zip_testzip"] = f"error: {type(e).__name__}: {e}"
        c = Path(str(base) + ".tar.csv")
        try:
            res["csv_entries"], res["csv_tar_length"] = csv_extent(c)
            if r["size"] is not None:
                res["csv_matches_local_size"] = res["csv_tar_length"] == r["size"] or (
                    -(-res["csv_tar_length"] // 10240) * 10240 == r["size"]
                )
        except FileNotFoundError:
            res["csv_entries"] = "missing"
        except (OSError, ValueError, KeyError, TypeError, csv.Error) as e:
            res["csv_entries"] = f"error: {type(e).__name__}: {e}"
        print(json.dumps(res), flush=True)
    return 0


def cmd_head(a: argparse.Namespace) -> int:
    import urllib.error
    import urllib.request

    bad = [r for r in load(Path(a.out)).values() if r["status"] != "ok"]
    for r in sorted(bad, key=lambda r: r["path"]):
        url = f"{a.base_url}/{r['path']}"
        res = {"path": r["path"], "url": url, "local_size": r["size"]}
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": a.user_agent})
            with urllib.request.urlopen(req, timeout=30) as resp:
                res["http_status"] = resp.status
                cl = resp.headers.get("Content-Length")
                res["remote_size"] = int(cl) if cl else None
                res["last_modified"] = resp.headers.get("Last-Modified")
        except (urllib.error.URLError, OSError, ValueError) as e:
            res["http_status"] = getattr(e, "code", None)
            res["error"] = str(e)
        if res.get("remote_size") is not None and r["size"] is not None:
            res["size_matches"] = res["remote_size"] == r["size"]
        print(json.dumps(res), flush=True)
        time.sleep(a.delay)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("audit", "summary", "inspect", "head"):
        s = sub.add_parser(name)
        s.add_argument("--out", default="/work/tar-audit.jsonl", help="results JSONL")
        if name in ("audit", "inspect"):
            s.add_argument("--root", default="/mirror/downloads")
    sub.choices["audit"].add_argument("--jobs", type=int, default=2, help="concurrent hashes (max 4)")
    sub.choices["audit"].add_argument("--every", type=float, default=60, help="progress interval, s")
    sub.choices["audit"].add_argument("--limit", type=int, default=0, help="stop after N files")
    sub.choices["audit"].add_argument("--reporter", action="append", help="only these reporters")
    sub.choices["audit"].add_argument("--path", action="append", help="only these tars (reporter/vol.tar)")
    sub.choices["summary"].add_argument("--json", action="store_true")
    sub.choices["head"].add_argument("--base-url", default=SOURCE_URL)
    sub.choices["head"].add_argument("--user-agent", default="codexpublicus-tar-audit/1 (+https://stare.pub)")
    sub.choices["head"].add_argument("--delay", type=float, default=0.5, help="seconds between requests")
    a = p.parse_args()
    return {"audit": cmd_audit, "summary": cmd_summary, "inspect": cmd_inspect, "head": cmd_head}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
