"""Copy citare's ``data/edition-slugs.json`` into ``src/stare_courtlistener/data/``.

    uv run python scripts/edition_slugs.py <citare checkout>

The copy is taken at the tag ``crates/stare/Cargo.toml`` pins citare to, so the pipeline
names reporters by the slugs the index build and the resolvers use. stare's
``crates/stare/tests/edition_slugs.rs`` fails when the copy and that citare disagree.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent.parent / "src" / "stare_courtlistener" / "data"


def pinned_tag() -> str:
    cargo = (ROOT / "crates" / "stare" / "Cargo.toml").read_text(encoding="utf-8")
    match = re.search(r'^citare-core = \{[^}]*\btag = "([^"]+)"', cargo, re.MULTILINE)
    if not match:
        raise SystemExit("no citare-core tag in crates/stare/Cargo.toml")
    return match.group(1)


def main(checkout: str) -> None:
    tag = pinned_tag()
    git = shutil.which("git")
    if git is None:
        raise SystemExit("git is not on PATH")
    data = subprocess.run(  # noqa: S603 (the operator's own checkout and stare's pinned tag)
        [git, "-C", checkout, "show", f"{tag}:data/edition-slugs.json"],
        check=True,
        capture_output=True,
    ).stdout
    (OUT / "edition-slugs.json").write_bytes(data)
    print(f"edition-slugs.json from citare {tag}")


if __name__ == "__main__":
    main(*sys.argv[1:])
