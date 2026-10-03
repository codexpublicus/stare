# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]==4.66.1"]
# ///
"""Subset the self-hosted web fonts into web/public/fonts/ (#102).

Downloads each upstream OFL release (pinned by SHA-256), subsets every face
into two WOFF2 tiers, and writes the @font-face rules:

- core: Basic Latin, Latin-1, General Punctuation, the arrows and marks the
  site's own UI draws, and every code point at least 0.001% frequent in the
  CAP sample (web/public/fonts/cap-glyphs.json).
- ext: everything else in the sample the font has. Its unicode-range keeps
  browsers from downloading it until a page uses one of those characters.

Outputs: web/public/fonts/<family>/<face>-{core,ext}.woff2 and OFL.txt,
web/public/fonts/SOURCES.md, web/src/styles/fonts.css (the default theme,
imported by theme.css) and web/src/styles/fonts-themes.css (vendored for
later themes; nothing links it yet).

    uv run web/scripts/subset-fonts.py [--cache DIR]
"""

import argparse
import hashlib
import io
import json
import unicodedata
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEB = Path(__file__).resolve().parent.parent
OUT = WEB / "public" / "fonts"
STYLES = WEB / "src" / "styles"

FEATURES = [
    "kern",
    "liga",
    "lnum",
    "onum",
    "tnum",
    "pnum",
    "smcp",
    "c2sc",
    "frac",
    "sups",
]

# Frequency at or above which a sampled code point goes in the core file.
CORE_FREQUENCY = 0.00001  # 0.001%

CORE = (
    set(range(0x20, 0x7F))  # Basic Latin
    | set(range(0xA0, 0x100))  # Latin-1: § ¶ ½ ¼ ¾ among them
    | set(range(0x2000, 0x2070))  # General Punctuation: dashes, curly quotes, † ‡, …
    # The UI's own marks: ← → ↗ (links out), − (zoom), ✓ ✗ (citation status).
    | {0x2190, 0x2192, 0x2197, 0x2212, 0x2713, 0x2717}
)


@dataclass(frozen=True)
class Upstream:
    family: str
    version: str
    repo: str
    url: str
    sha256: str


UPSTREAM = {
    "source-serif": Upstream(
        "Source Serif 4",
        "4.005",
        "https://github.com/adobe-fonts/source-serif",
        "https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_Desktop.zip",
        "549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425",
    ),
    "source-sans-vf": Upstream(
        "Source Sans 3",
        "3.052",
        "https://github.com/adobe-fonts/source-sans",
        "https://github.com/adobe-fonts/source-sans/releases/download/3.052R/VF-source-sans-3.052R.zip",
        "d8e2ac355e06e6a0f0e0a0b1ac0c2451afa707584d7bb9d6b11ef9e4b749904c",
    ),
    "source-sans-license": Upstream(
        "Source Sans 3",
        "3.052",
        "https://github.com/adobe-fonts/source-sans",
        "https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/LICENSE.md",
        "89ad2c4f66dd29127527493e729c31e731f111cf10faf5774c3db9275ed0c22c",
    ),
    "source-code-vf": Upstream(
        "Source Code Pro",
        "1.026 (variable)",
        "https://github.com/adobe-fonts/source-code-pro",
        "https://github.com/adobe-fonts/source-code-pro/releases/download/2.042R-u%2F1.062R-i%2F1.026R-vf/VF-source-code-VF-1.026R.zip",
        "0660ba0cd1478f92cfcf2ad790b7aa29f8adb2daf15598f452a65ae61c9c9fb1",
    ),
    "source-code-license": Upstream(
        "Source Code Pro",
        "2.042R-u/1.062R-i/1.026R-vf",
        "https://github.com/adobe-fonts/source-code-pro",
        "https://raw.githubusercontent.com/adobe-fonts/source-code-pro/2.042R-u/1.062R-i/1.026R-vf/LICENSE.md",
        "7c940e28a5388e9bba866cf0e408edda45fe0899ba98665b8f6ab31dc5e4b8ff",
    ),
    "charis": Upstream(
        "Charis",
        "7.000",
        "https://github.com/silnrsi/font-charis",
        "https://github.com/silnrsi/font-charis/releases/download/v7.000/Charis-7.000.zip",
        "e3237b1303c5d31af8f59b1d1914886c5e873b77c71390e4742fb3bc1c187666",
    ),
    "plex-mono-vf": Upstream(
        "IBM Plex Mono",
        "1.000 (@ibm/plex-mono-variable 1.0.0)",
        "https://github.com/IBM/plex",
        "https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-mono-variable%401.0.0/plex-mono-variable.zip",
        "46bbde4aeab959180ebad197f5b841c6bb5c8070146ba02c31240556e1e0b40d",
    ),
    "plex-mono-license": Upstream(
        "IBM Plex Mono",
        "2.5.0 (@ibm/plex-mono; license only)",
        "https://github.com/IBM/plex",
        "https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-mono%402.5.0/ibm-plex-mono.zip",
        "6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c",
    ),
}

# Merriweather publishes no release archives; these are its repos' files at a
# pinned commit.
_MW = "https://raw.githubusercontent.com/SorkinType/Merriweather/4481226b336843648b5b2ee64f75737f262ded15/"
_MS = "https://raw.githubusercontent.com/SorkinType/Merriweather-Sans/bb6bd99bf9eb756723f2428629659a638702d335/"
UPSTREAM |= {
    "merriweather-roman": Upstream(
        "Merriweather",
        "2.200 (commit 4481226)",
        "https://github.com/SorkinType/Merriweather",
        _MW + "fonts/variable/Merriweather%5Bopsz,wdth,wght%5D.ttf",
        "c91f7d7f144603eef74dda45e18a8ca9997eb9f8c9aab66cd62363a3a0bb0d10",
    ),
    "merriweather-italic": Upstream(
        "Merriweather",
        "2.200 (commit 4481226)",
        "https://github.com/SorkinType/Merriweather",
        _MW + "fonts/variable/Merriweather-Italic%5Bopsz,wdth,wght%5D.ttf",
        "3f86fa8dbfc8d7cb244ab5e7215c54c73a838e590f970ba2213d2b81d356cd19",
    ),
    "merriweather-license": Upstream(
        "Merriweather",
        "commit 4481226",
        "https://github.com/SorkinType/Merriweather",
        _MW + "OFL.txt",
        "a7ba785ad99b6eae0444ab89910e512d4af9865937fddbcb5c72c4f59f55d6ad",
    ),
    "merriweather-sans-roman": Upstream(
        "Merriweather Sans",
        "2.001 (commit bb6bd99)",
        "https://github.com/SorkinType/Merriweather-Sans",
        _MS + "fonts/variable/MerriweatherSans%5Bwght%5D.ttf",
        "bef90d227eeb5b58e27d0a421df6c5d8df2e6a6d68aa08bdc51faa54f1d997dc",
    ),
    "merriweather-sans-italic": Upstream(
        "Merriweather Sans",
        "2.001 (commit bb6bd99)",
        "https://github.com/SorkinType/Merriweather-Sans",
        _MS + "fonts/variable/MerriweatherSans-Italic%5Bwght%5D.ttf",
        "882e6763fa1f35dc03cd61c1e3186dba2408828c807895dfa16875b1242ad59d",
    ),
    "merriweather-sans-license": Upstream(
        "Merriweather Sans",
        "commit bb6bd99",
        "https://github.com/SorkinType/Merriweather-Sans",
        _MS + "OFL.txt",
        "c487138e4ea4688386abfaf72ab2cbc72a7c8c358cca19bd70095e0d07d8d9f2",
    ),
}


@dataclass(frozen=True)
class Src:
    upstream: str
    member: str | None = None  # path inside the archive; None for a bare file


@dataclass(frozen=True)
class Face:
    name: str  # output file stem
    style: str  # CSS font-style
    weight: str  # CSS font-weight (a range for a variable face)
    src: Src
    # varLib.instancer limits: a range keeps the axis, a number pins it. A
    # face whose every axis is pinned is a static instance.
    axes: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Family:
    css: str
    slug: str
    fallback: str
    stylesheet: str  # "fonts.css" (linked) or "fonts-themes.css" (vendored)
    license: Src
    faces: tuple[Face, ...]
    note: str


_SS = "source-serif-4.005_Desktop/"


def _mw(weight: int, italic: bool) -> Face:
    name = {
        (400, False): "regular",
        (400, True): "italic",
        (700, False): "bold",
        (700, True): "bold-italic",
    }
    return Face(
        name[weight, italic],
        "italic" if italic else "normal",
        str(weight),
        Src("merriweather-italic" if italic else "merriweather-roman"),
        {"wght": weight, "wdth": 100, "opsz": 16},
    )


def _ms(weight: int, italic: bool) -> Face:
    name = {
        (400, False): "regular",
        (400, True): "italic",
        (700, False): "bold",
        (700, True): "bold-italic",
    }
    return Face(
        name[weight, italic],
        "italic" if italic else "normal",
        str(weight),
        Src("merriweather-sans-italic" if italic else "merriweather-sans-roman"),
        {"wght": weight},
    )


FAMILIES = (
    Family(
        "Source Serif 4",
        "source-serif-4",
        "Georgia, 'Times New Roman', serif",
        "fonts.css",
        Src("source-serif", _SS + "LICENSE.md"),
        (
            Face(
                "regular",
                "normal",
                "400",
                Src("source-serif", _SS + "TTF/SourceSerif4-Regular.ttf"),
            ),
            Face(
                "italic",
                "italic",
                "400",
                Src("source-serif", _SS + "TTF/SourceSerif4-It.ttf"),
            ),
            Face(
                "bold",
                "normal",
                "700",
                Src("source-serif", _SS + "TTF/SourceSerif4-Bold.ttf"),
            ),
            Face(
                "bold-italic",
                "italic",
                "700",
                Src("source-serif", _SS + "TTF/SourceSerif4-BoldIt.ttf"),
            ),
        ),
        "Static. The variable font's opsz axis makes its two files 2.2x the four statics combined.",
    ),
    Family(
        "Source Sans 3",
        "source-sans-3",
        "-apple-system, system-ui, 'Segoe UI', sans-serif",
        "fonts.css",
        Src("source-sans-license"),
        (
            Face(
                "roman",
                "normal",
                "200 900",
                Src("source-sans-vf", "VF/SourceSans3VF-Upright.ttf"),
            ),
            Face(
                "italic",
                "italic",
                "200 900",
                Src("source-sans-vf", "VF/SourceSans3VF-Italic.ttf"),
            ),
        ),
        "Variable (wght 200-900): smaller than the four statics, and the UI's 500 and 600 "
        "weights are real.",
    ),
    Family(
        "Source Code Pro",
        "source-code-pro",
        "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        "fonts.css",
        Src("source-code-license"),
        (
            Face(
                "roman",
                "normal",
                "200 900",
                Src("source-code-vf", "VF/SourceCodeVF-Upright.ttf"),
            ),
            Face(
                "italic",
                "italic",
                "200 900",
                Src("source-code-vf", "VF/SourceCodeVF-Italic.ttf"),
            ),
        ),
        "Variable (wght 200-900): smaller than the four statics.",
    ),
    Family(
        "Charis",
        "charis",
        "Georgia, 'Times New Roman', serif",
        "fonts-themes.css",
        Src("charis", "Charis-7.000/OFL.txt"),
        (
            Face(
                "regular",
                "normal",
                "400",
                Src("charis", "Charis-7.000/Charis-Regular.ttf"),
            ),
            Face(
                "italic",
                "italic",
                "400",
                Src("charis", "Charis-7.000/Charis-Italic.ttf"),
            ),
            Face("bold", "normal", "700", Src("charis", "Charis-7.000/Charis-Bold.ttf")),
            Face(
                "bold-italic",
                "italic",
                "700",
                Src("charis", "Charis-7.000/Charis-BoldItalic.ttf"),
            ),
        ),
        "Static; Charis has no variable release.",
    ),
    Family(
        "IBM Plex Mono",
        "ibm-plex-mono",
        "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        "fonts-themes.css",
        Src("plex-mono-license", "ibm-plex-mono/LICENSE.txt"),
        (
            Face(
                "roman",
                "normal",
                "400 700",
                Src("plex-mono-vf", "fonts/complete/ttf/IBM Plex Mono Var-Roman.ttf"),
                {"wght": (400, 700)},
            ),
            Face(
                "italic",
                "italic",
                "400 700",
                Src("plex-mono-vf", "fonts/complete/ttf/IBM Plex Mono Var-Italic.ttf"),
                {"wght": (400, 700)},
            ),
        ),
        "Variable, wght limited to 400-700: smaller than the four statics.",
    ),
    Family(
        "Merriweather",
        "merriweather",
        "Georgia, 'Times New Roman', serif",
        "fonts-themes.css",
        Src("merriweather-license"),
        (_mw(400, False), _mw(400, True), _mw(700, False), _mw(700, True)),
        "Static instances (wdth 100, opsz 16) of the variable font: the variable files with "
        "opsz are 1.6x the four statics.",
    ),
    Family(
        "Merriweather Sans",
        "merriweather-sans",
        "-apple-system, system-ui, 'Segoe UI', sans-serif",
        "fonts-themes.css",
        Src("merriweather-sans-license"),
        (_ms(400, False), _ms(400, True), _ms(700, False), _ms(700, True)),
        "Static instances of the variable font, which is 1.2x the four statics.",
    ),
)


def fetch(cache: Path, key: str) -> bytes:
    up = UPSTREAM[key]
    path = cache / hashlib.sha256(up.url.encode()).hexdigest()[:16]
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        if not up.url.startswith("https://"):
            raise SystemExit(f"{up.url}: not https")
        with urllib.request.urlopen(up.url) as r:  # noqa: S310 (https only, checked above)
            path.write_bytes(r.read())
    data = path.read_bytes()
    got = hashlib.sha256(data).hexdigest()
    if got != up.sha256:
        raise SystemExit(f"{up.url}: SHA-256 {got}, expected {up.sha256}")
    return data


def read(cache: Path, src: Src) -> bytes:
    data = fetch(cache, src.upstream)
    if src.member is None:
        return data
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.read(src.member)


def ranges(cps: set[int]) -> str:
    out, cps = [], sorted(cps)
    i = 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f"U+{cps[i]:X}" if i == j else f"U+{cps[i]:X}-{cps[j]:X}")
        i = j + 1
    return ", ".join(out)


def features(font: TTFont) -> set[str]:
    return {
        rec.FeatureTag
        for tag in ("GSUB", "GPOS")
        if tag in font
        for rec in font[tag].table.FeatureList.FeatureRecord
    }


def subset(raw: bytes, face: Face, unicodes: set[int]) -> bytes:
    # Keep the upstream head.modified, so the same inputs give byte-identical files.
    font = TTFont(io.BytesIO(raw), recalcTimestamp=False)
    opts = Options()
    opts.layout_features += FEATURES
    opts.hinting = False
    opts.desubroutinize = True
    opts.name_IDs = ["*"]  # keep the copyright, license and trademark records
    sub = Subsetter(opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    if face.axes:
        font = instancer.instantiateVariableFont(font, face.axes)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "stare-fonts")
    args = ap.parse_args()

    glyphs = json.loads((OUT / "cap-glyphs.json").read_text())
    total = glyphs["total_code_points"]
    sample = {
        int(k[2:], 16): n
        for k, n in glyphs["counts"].items()
        if unicodedata.category(chr(int(k[2:], 16))) not in ("Cc", "Co")
    }
    core = CORE | {cp for cp, n in sample.items() if n / total >= CORE_FREQUENCY}
    extended = set(sample) - core

    css = {"fonts.css": [], "fonts-themes.css": []}
    report, missing, lacking = [], {}, {}
    for fam in FAMILIES:
        (OUT / fam.slug).mkdir(parents=True, exist_ok=True)
        (OUT / fam.slug / "OFL.txt").write_bytes(read(args.cache, fam.license))
        for face in fam.faces:
            raw = read(args.cache, face.src)
            font = TTFont(io.BytesIO(raw))
            cmap = set(font.getBestCmap())
            lacking[fam.css, face.name] = [f for f in FEATURES if f not in features(font)]
            missing.setdefault(fam.css, set()).update(set(sample) - cmap)
            for tier, cps in (("core", core & cmap), ("ext", extended & cmap)):
                if not cps:
                    continue
                name = f"{face.name}-{tier}.woff2"
                data = subset(raw, face, cps)
                (OUT / fam.slug / name).write_bytes(data)
                report.append((fam, face, tier, f"{fam.slug}/{name}", len(data), len(cps)))
                css[fam.stylesheet].append(
                    "@font-face {\n"
                    f"  font-family: '{fam.css}';\n"
                    f"  font-style: {face.style};\n"
                    f"  font-weight: {face.weight};\n"
                    "  font-display: swap;\n"
                    f"  src: url('/fonts/{fam.slug}/{name}') format('woff2');\n"
                    f"  unicode-range: {ranges(cps)};\n"
                    "}\n"
                )

    header = "/* Generated by web/scripts/subset-fonts.py; edit that, not this. */\n"
    (STYLES / "fonts.css").write_text(
        header
        + "/* The default theme's faces (#102), imported by theme.css. */\n\n"
        + "\n".join(css["fonts.css"])
    )
    (STYLES / "fonts-themes.css").write_text(
        header + "/* Faces vendored for later themes (#102). Nothing imports this file yet;\n"
        "   Source Sans 3 and Source Code Pro, which those themes share, are in fonts.css. */\n\n"
        + "\n".join(css["fonts-themes.css"])
    )

    md = [
        "# Web fonts",
        "",
        "Generated by `web/scripts/subset-fonts.py`, which downloads each upstream file below,",
        "checks its SHA-256, and subsets it. All are under the SIL Open Font License 1.1; each",
        "family's directory has its license as `OFL.txt`.",
        "",
        "## Upstream files",
        "",
        "| Family | Version | File | SHA-256 |",
        "| --- | --- | --- | --- |",
    ]
    for up in UPSTREAM.values():
        md.append(f"| [{up.family}]({up.repo}) | {up.version} | <{up.url}> | `{up.sha256}` |")
    md += [
        "",
        "## Subsets",
        "",
        "Each face is split in two. The core file has Basic Latin, Latin-1, General "
        "Punctuation, the UI's arrows and check marks, and every code point at least "
        f"{CORE_FREQUENCY:.3%} frequent in `cap-glyphs.json` ({glyphs['cases']:,} cases from "
        f"{glyphs['volumes']} volumes, one per reporter). "
        "The ext file has every other sampled code point the font has, and loads only when a page "
        "uses one. Hinting is dropped; OpenType features kept: "
        + ", ".join(FEATURES)
        + " (where the font has them).",
        "",
        "| Family | Face | Tier | File | Code points | Bytes |",
        "| --- | --- | --- | --- | ---: | ---: |",
    ]
    for fam, face, tier, path, size, n in report:
        face_label = f"{face.name} ({face.style} {face.weight})"
        md.append(f"| {fam.css} | {face_label} | {tier} | `{path}` | {n} | {size:,} |")
    md += ["", "## Static or variable", ""]
    for fam in FAMILIES:
        md.append(f"- **{fam.css}**: {fam.note}")
    md += ["", "## Kept features the upstream face lacks", ""]
    for (fam_css, face_name), feats in lacking.items():
        md.append(f"- {fam_css} {face_name}: " + (", ".join(feats) if feats else "none"))
    md += ["", "## Sampled code points each family lacks", ""]
    for fam_css, cps in missing.items():
        if cps:
            md.append(
                f"- **{fam_css}**: "
                + ", ".join(
                    f"U+{cp:04X} {unicodedata.name(chr(cp), '?').lower()} ({sample[cp]:,})"
                    for cp in sorted(cps)
                )
            )
        else:
            md.append(f"- **{fam_css}**: none")
    (OUT / "SOURCES.md").write_text("\n".join(md) + "\n")

    for _fam, _face, _tier, path, size, n in report:
        print(f"{path:45} {n:4} cps {size:8,} B")


if __name__ == "__main__":
    main()
