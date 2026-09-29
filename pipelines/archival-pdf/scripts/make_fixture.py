"""Build the test fixture: a small tar slice of a2d/152 and its .tar.csv.

usage: uv run python scripts/make_fixture.py <members dir> <out dir>

<members dir> holds real members of a2d/152.tar, fetched read-only by byte range from the
mirror (see tests/fixtures/README.md), laid out at their tar paths. The volume METS is trimmed
to the chosen pages and cases; every other member is copied byte for byte. The output tar is
deterministic (fixed mtime, owner and mode) so rebuilding it gives the same bytes.
"""

import gzip
import io
import sys
import tarfile
from pathlib import Path

from lxml import etree

ROOT = "32044109578831_redacted"
PAGE_ORDERS = {870, 871, 872, 873}
CASE_FILE_IDS = {"casemets_0201", "casemets_0202", "casemets_0203"}
NS = {"m": "http://www.loc.gov/METS/"}


def trim_mets(raw_gz: bytes) -> bytes:
    tree = etree.fromstring(gzip.decompress(raw_gz))
    physical = tree.find("m:structMap[@TYPE='physical']", NS)
    for div in list(physical.iterfind(".//m:div[@TYPE='page']", NS)):
        if int(div.get("ORDER")) not in PAGE_ORDERS:
            div.getparent().remove(div)
    logical = tree.find("m:structMap[@TYPE='logical']", NS)
    for div in list(logical.iterfind(".//m:div[@TYPE='case']", NS)):
        if div.find("m:fptr", NS).get("FILEID") not in CASE_FILE_IDS:
            div.getparent().remove(div)
    kept = {fp.get("FILEID") for fp in tree.iterfind(".//m:structMap//m:fptr[@FILEID]", NS)}
    for f in list(tree.iterfind(".//m:fileSec//m:file", NS)):
        if f.get("ID") not in kept:
            f.getparent().remove(f)
    xml = etree.tostring(tree, xml_declaration=True, encoding="utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, filename="") as gz:
        gz.write(xml)
    return buf.getvalue()


def add(tar: tarfile.TarFile, name: str, data: bytes | None) -> None:
    info = tarfile.TarInfo(name)
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    if data is None:
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
    else:
        info.mode = 0o644
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    base = src / ROOT
    entries: list[tuple[str, bytes | None]] = [(ROOT, None)]
    for sub in ("alto", "images", "casemets"):
        entries.append((f"{ROOT}/{sub}", None))
        for f in sorted((base / sub).iterdir()):
            entries.append((f"{ROOT}/{sub}/{f.name}", f.read_bytes()))
    mets = f"{ROOT}_METS.xml.gz"
    entries.append((f"{ROOT}/{mets}", trim_mets((base / mets).read_bytes())))

    tar_path = out / "152.tar"
    with tarfile.open(tar_path, "w", format=tarfile.USTAR_FORMAT) as tar:
        for name, data in entries:
            add(tar, name, data)
    lines = ["path,offset,size"]
    with tarfile.open(tar_path) as tar:
        for m in tar.getmembers():
            lines.append(f"{m.name},{m.offset_data},{m.size}")
    # the mirror's manifests use CRLF line endings; keep that
    (out / "152.tar.csv").write_bytes(("\r\n".join(lines) + "\r\n").encode())


if __name__ == "__main__":
    main()
