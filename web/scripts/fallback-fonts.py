# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]==4.66.1"]
# ///
"""Write the metric-matched fallback faces for the web fonts (#261).

Until a web font arrives the browser draws its text in a system font, and when the web
font swaps in, every line of text changes width and height. Each face here is a local
system font scaled with `size-adjust` so its average character is as wide as the web
font's, with `ascent-override`, `descent-override` and `line-gap-override` set to the
web font's own (scaled back by the same factor), so the text wraps and stacks the same
in both. theme.css lists them after each web font and before the plain system fonts.

The average width is the one Capsize uses (@capsizecss/unpack 4.0.1, MIT, SEEK): each
character's advance weighted by its frequency in English text (`WEIGHTS`). The web
fonts' widths and vertical metrics are read from the core files in web/public/fonts.
The system fonts can't be read in CI, so their figures are recorded below: Capsize's
@capsizecss/metrics 4.4.0 for the fonts it covers, and DejaVu's from the DejaVu 2.37
files, measured the same way. Liberation Serif, Sans and Mono share Times New Roman's,
Arial's and Courier New's metrics by design, so they share those faces.

Output: web/src/styles/fonts-fallback.css, imported by theme.css.

    uv run web/scripts/fallback-fonts.py
"""

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEB = Path(__file__).resolve().parent.parent
FONTS = WEB / "public" / "fonts"
OUT = WEB / "src" / "styles" / "fonts-fallback.css"

# Capsize's `latin` weighting (@capsizecss/unpack 4.0.1, src/weightings.ts).
WEIGHTS = {
    "0": 0.0053, "1": 0.0023, "2": 0.0026, "3": 0.001, "4": 0.0008, "5": 0.0015,
    "6": 0.0007, "7": 0.0005, "8": 0.0007, "9": 0.0006, ",": 0.0083, " ": 0.154,
    "t": 0.0672, "h": 0.0351, "e": 0.0922, "o": 0.0571, "f": 0.017, "P": 0.0023,
    "p": 0.0163, "l": 0.0304, "'": 0.0014, "s": 0.0469, "R": 0.0015, "u": 0.0207,
    "b": 0.0114, "i": 0.0588, "c": 0.0232, "C": 0.0031, "n": 0.0578, "a": 0.0668,
    "d": 0.0298, "y": 0.0123, "w": 0.011, "B": 0.002, "r": 0.0526, "z": 0.0011,
    "G": 0.0011, "j": 0.0009, "T": 0.0041, ".": 0.0079, "L": 0.0012, "k": 0.0046,
    "m": 0.0181, "]": 0.0007, "J": 0.0009, "F": 0.0015, "v": 0.0076, "g": 0.0155,
    "A": 0.004, "N": 0.0014, "-": 0.0018, "H": 0.0013, "D": 0.0013, "M": 0.0025,
    "I": 0.0022, "E": 0.0011, '"': 0.0012, "S": 0.0041, "(": 0.001, ")": 0.001,
    "x": 0.0025, "W": 0.0012, "Q": 0.0001, "Y": 0.0003, "q": 0.0008, "V": 0.0005,
    "á": 0.0001, "K": 0.0007, "U": 0.0016, "=": 0.0007, "[": 0.0021, "O": 0.0009,
    "é": 0.0001, "$": 0.0002, ":": 0.0008, "|": 0.0038, "/": 0.0001, "%": 0.0001,
    "Z": 0.0002, ";": 0.0001, "X": 0.0001,
}  # fmt: skip


@dataclass(frozen=True)
class Metrics:
    ascent: int  # hhea, font units
    descent: int  # hhea, negative
    line_gap: int
    upm: int
    avg: int  # weighted average advance, font units


@dataclass(frozen=True)
class System:
    """A system font, by the names `local()` can find it under."""

    locals: tuple[str, ...]
    metrics: Metrics


# Capsize's @capsizecss/metrics 4.4.0 (hhea ascent, descent, lineGap, unitsPerEm, xWidthAvg);
# DejaVu measured from the 2.37 files.
GEORGIA = System(("Georgia",), Metrics(1878, -449, 0, 2048, 913))
GEORGIA_I = System(("Georgia Italic", "Georgia-Italic"), Metrics(1878, -449, 0, 2048, 931))
GEORGIA_B = System(("Georgia Bold", "Georgia-Bold"), Metrics(1878, -449, 0, 2048, 1062))
TIMES = System(
    ("Times New Roman", "TimesNewRomanPSMT", "Liberation Serif", "LiberationSerif"),
    Metrics(1825, -443, 87, 2048, 832),
)
TIMES_I = System(
    ("Times New Roman Italic", "TimesNewRomanPS-ItalicMT", "Liberation Serif Italic",
     "LiberationSerif-Italic"),
    Metrics(1825, -443, 87, 2048, 836),
)  # fmt: skip
TIMES_B = System(
    ("Times New Roman Bold", "TimesNewRomanPS-BoldMT", "Liberation Serif Bold",
     "LiberationSerif-Bold"),
    Metrics(1825, -443, 87, 2048, 886),
)  # fmt: skip
NOTO_SERIF = System(("Noto Serif", "Noto Serif Regular", "NotoSerif-Regular"), Metrics(1069, -293, 0, 1000, 481))
NOTO_SERIF_I = System(("Noto Serif Italic", "NotoSerif-Italic"), Metrics(1069, -293, 0, 1000, 469))
NOTO_SERIF_B = System(("Noto Serif Bold", "NotoSerif-Bold"), Metrics(1069, -293, 0, 1000, 512))
DEJAVU_SERIF = System(("DejaVu Serif", "DejaVuSerif"), Metrics(1901, -483, 0, 2048, 1058))
DEJAVU_SERIF_B = System(("DejaVu Serif Bold", "DejaVuSerif-Bold"), Metrics(1923, -483, 0, 2048, 1168))

ARIAL = System(
    ("Arial", "ArialMT", "Liberation Sans", "LiberationSans"), Metrics(1854, -434, 67, 2048, 913)
)
ARIAL_B = System(
    ("Arial Bold", "Arial-BoldMT", "Liberation Sans Bold", "LiberationSans-Bold"),
    Metrics(1854, -434, 67, 2048, 983),
)
HELVETICA = System(("Helvetica",), Metrics(1577, -471, 0, 2048, 913))
HELVETICA_B = System(("Helvetica Bold", "Helvetica-Bold"), Metrics(1577, -471, 0, 2048, 983))
SEGOE = System(("Segoe UI", "SegoeUI"), Metrics(2210, -514, 0, 2048, 908))
SEGOE_B = System(("Segoe UI Semibold", "SegoeUI-Semibold"), Metrics(2210, -514, 0, 2048, 937))
ROBOTO = System(("Roboto", "Roboto Regular", "Roboto-Regular"), Metrics(1900, -500, 0, 2048, 911))
ROBOTO_B = System(("Roboto Medium", "Roboto-Medium", "Roboto SemiBold", "Roboto-SemiBold"), Metrics(1900, -500, 0, 2048, 923))
NOTO_SANS = System(("Noto Sans", "Noto Sans Regular", "NotoSans-Regular"), Metrics(1069, -293, 0, 1000, 474))
NOTO_SANS_B = System(("Noto Sans SemiBold", "NotoSans-SemiBold"), Metrics(1069, -293, 0, 1000, 492))
DEJAVU_SANS = System(("DejaVu Sans", "DejaVuSans"), Metrics(1901, -483, 0, 2048, 1041))
DEJAVU_SANS_B = System(("DejaVu Sans Bold", "DejaVuSans-Bold"), Metrics(1901, -483, 0, 2048, 1176))

COURIER = System(
    ("Courier New", "CourierNewPSMT", "Liberation Mono", "LiberationMono"),
    Metrics(1705, -615, 0, 2048, 1229),
)
DEJAVU_MONO = System(("DejaVu Sans Mono", "DejaVuSansMono"), Metrics(1901, -483, 0, 2048, 1233))


@dataclass(frozen=True)
class Face:
    """One web font face to match: its file, the axis values to read it at, and the CSS
    font-style and font-weight its stand-ins cover."""

    file: str
    style: str
    weight: str
    axes: dict


# family name suffix -> [(web font face, system font)]
FAMILIES = {
    "Source Serif 4": {
        "Georgia": [
            (Face("source-serif-4/regular-core.woff2", "normal", "400", {}), GEORGIA),
            (Face("source-serif-4/italic-core.woff2", "italic", "400", {}), GEORGIA_I),
            (Face("source-serif-4/bold-core.woff2", "normal", "700", {}), GEORGIA_B),
        ],
        "Times": [
            (Face("source-serif-4/regular-core.woff2", "normal", "400", {}), TIMES),
            (Face("source-serif-4/italic-core.woff2", "italic", "400", {}), TIMES_I),
            (Face("source-serif-4/bold-core.woff2", "normal", "700", {}), TIMES_B),
        ],
        "Noto": [
            (Face("source-serif-4/regular-core.woff2", "normal", "400", {}), NOTO_SERIF),
            (Face("source-serif-4/italic-core.woff2", "italic", "400", {}), NOTO_SERIF_I),
            (Face("source-serif-4/bold-core.woff2", "normal", "700", {}), NOTO_SERIF_B),
        ],
        "DejaVu": [
            (Face("source-serif-4/regular-core.woff2", "normal", "400", {}), DEJAVU_SERIF),
            (Face("source-serif-4/bold-core.woff2", "normal", "700", {}), DEJAVU_SERIF_B),
        ],
    },
    # The UI's weights are 400 to 600; a stand-in's bold covers 600 and up.
    "Source Sans 3": {
        name: [
            (Face("source-sans-3/roman-core.woff2", "normal", "200 550", {"wght": 400}), regular),
            (Face("source-sans-3/roman-core.woff2", "normal", "551 900", {"wght": 600}), bold),
        ]
        for name, regular, bold in (
            ("Arial", ARIAL, ARIAL_B),
            ("Helvetica", HELVETICA, HELVETICA_B),
            ("Segoe", SEGOE, SEGOE_B),
            ("Roboto", ROBOTO, ROBOTO_B),
            ("Noto", NOTO_SANS, NOTO_SANS_B),
            ("DejaVu", DEJAVU_SANS, DEJAVU_SANS_B),
        )
    },
    "Source Code Pro": {
        "Courier": [(Face("source-code-pro/roman-core.woff2", "normal", "200 900", {"wght": 400}), COURIER)],
        "DejaVu": [(Face("source-code-pro/roman-core.woff2", "normal", "200 900", {"wght": 400}), DEJAVU_MONO)],
    },
}


def measure(face: Face) -> Metrics:
    font = TTFont(FONTS / face.file)
    if face.axes and "fvar" in font:
        font = instancer.instantiateVariableFont(font, face.axes)
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    missing = [c for c in WEIGHTS if ord(c) not in cmap]
    if missing:
        raise SystemExit(f"{face.file} lacks {missing}")
    avg = round(sum(hmtx[cmap[ord(c)]][0] * w for c, w in WEIGHTS.items()))
    hhea = font["hhea"]
    return Metrics(hhea.ascent, hhea.descent, hhea.lineGap, font["head"].unitsPerEm, avg)


def pct(v: float) -> str:
    return f"{v * 100:.2f}%"


def main() -> None:
    cache: dict[tuple, Metrics] = {}
    rules, table = [], []
    for family, systems in FAMILIES.items():
        for suffix, pairs in systems.items():
            name = f"{family} {suffix}"
            for face, system in pairs:
                key = (face.file, tuple(sorted(face.axes.items())))
                if key not in cache:
                    cache[key] = measure(face)
                web = cache[key]
                sys_m = system.metrics
                size = (web.avg / web.upm) / (sys_m.avg / sys_m.upm)
                ascent = web.ascent / web.upm / size
                descent = -web.descent / web.upm / size
                gap = web.line_gap / web.upm / size
                src = ", ".join(f"local('{n}')" for n in system.locals)
                rules.append(
                    "@font-face {\n"
                    f"  font-family: '{name}';\n"
                    f"  font-style: {face.style};\n"
                    f"  font-weight: {face.weight};\n"
                    f"  src: {src};\n"
                    f"  size-adjust: {pct(size)};\n"
                    f"  ascent-override: {pct(ascent)};\n"
                    f"  descent-override: {pct(descent)};\n"
                    f"  line-gap-override: {pct(gap)};\n"
                    "}\n"
                )
                table.append(f"{name:30} {face.style:6} {face.weight:8} {system.locals[0]:24} {pct(size):>8}")
    OUT.write_text(
        "/* Generated by web/scripts/fallback-fonts.py; edit that, not this. */\n"
        "/* Metric-matched stand-ins for the web fonts while they load (#261): a local system\n"
        "   font scaled to the web font's average width, with its ascent, descent and line gap. */\n\n"
        + "\n".join(rules)
    )
    print("\n".join(table))


if __name__ == "__main__":
    main()
