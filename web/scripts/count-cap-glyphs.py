"""Count the code points in CAP case text, for web/scripts/subset-fonts.py (#102).

Reads one randomly chosen volume per reporter from the read-only CAP mirror
and writes /work/cap-glyphs.json, which is committed as
web/public/fonts/cap-glyphs.json:

    cap-mirror-run <scratch dir> python /work/count-cap-glyphs.py

Standard library only, for the python:3.12-alpine image cap-mirror-run uses.
"""

import json
import random
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path("/mirror/downloads")
OUT = Path("/work/cap-glyphs.json")


def walk(value, counts: Counter) -> None:
    if isinstance(value, str):
        counts.update(value)
    elif isinstance(value, dict):
        for v in value.values():
            walk(v, counts)
    elif isinstance(value, list):
        for v in value:
            walk(v, counts)


def main() -> None:
    rng = random.Random(102)  # noqa: S311 (a reproducible sample, not a secret)
    counts: Counter = Counter()
    volumes, cases = [], 0
    started = time.time()
    for reporter in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        zips = sorted(p.name for p in reporter.glob("*.zip"))
        if not zips:
            continue
        name = rng.choice(zips)
        try:
            with zipfile.ZipFile(reporter / name) as zf:
                for member in zf.namelist():
                    if member.startswith("json/") and member.endswith(".json"):
                        case = json.loads(zf.read(member))
                        walk(case.get("casebody", {}), counts)
                        walk(case.get("name", ""), counts)
                        walk(case.get("name_abbreviation", ""), counts)
                        cases += 1
            volumes.append(f"{reporter.name}/{name.removesuffix('.zip')}")
        except (OSError, zipfile.BadZipFile, json.JSONDecodeError) as e:
            print("skip", reporter.name, name, e, file=sys.stderr)

    total = sum(counts.values())
    head = {
        "description": (
            "Code point frequencies in CAP case text: every string under casebody, plus name "
            "and name_abbreviation, in every case of one randomly chosen volume per reporter "
            "(seed 102). Made by web/scripts/count-cap-glyphs.py; read by "
            "web/scripts/subset-fonts.py."
        ),
        "volumes": len(volumes),
        "cases": cases,
        "total_code_points": total,
    }
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    with OUT.open("w") as f:
        f.write(json.dumps(head, indent=2, ensure_ascii=False)[:-2] + ',\n  "counts": {\n')
        f.write(",\n".join(f'    "U+{ord(c):04X}": {n}' for c, n in ranked))
        f.write('\n  },\n  "sampled_volumes": ' + json.dumps(volumes) + "\n}\n")
    print(
        f"{len(volumes)} volumes, {cases} cases, {total} code points, "
        f"{len(counts)} distinct, {time.time() - started:.0f} s"
    )


if __name__ == "__main__":
    main()
