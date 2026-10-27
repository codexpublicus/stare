# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]==4.66.1", "pillow==11.3.0"]
# ///
"""Draw stare.pub's § tablet mark, its wordmark and the favicons (#257).

The mark is the Codex Publicus tablet (codexpublicus/codexpublicus.org, D112): a cap
over a body, in the text colour. The umbrella mark cuts four lines into the body;
stare.pub's tablet carries § instead, in the family's glyph green. Two drawings:

- full (viewBox 0 0 40 48), for 32 px and up: the § is Source Serif 4's glyph at 24
  units, centred on x 20 with its baseline at y 36, as codexpublicus.org draws it.
- small (viewBox 0 0 16 16, crispEdges), for 16 to 24 px: the same cap and body on a
  16 px grid, with a § drawn in whole pixels so it stays crisp at 16 px.

The wordmark is "stare.pub" in Cinzel 500, outlined, so the header needs no font
download and can't shift when one arrives.

The favicon is the small drawing with a 1 px ground-coloured outline around the cap
and body, as codexpublicus.org's is: it reads on a dark tab bar and looks the same on
a light one.

Outputs:
  web/src/lib/marks.js           the path data and markup the pages use
  web/public/favicon.svg         the small drawing with its outline
  web/public/favicon-32.png      the same at 2x
  web/public/favicon.ico         16 and 32 px, pixel for pixel
  web/public/apple-touch-icon.png  the full drawing, 180 px, on the ground colour

    uv run web/scripts/marks.py [--cache DIR]
"""

import argparse
import hashlib
import importlib.util
import io
import urllib.request
import zipfile
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image, ImageChops, ImageDraw

WEB = Path(__file__).resolve().parent.parent
PUBLIC = WEB / "public"

# The family palette (codexpublicus.org public/style.css).
GROUND = "#f8f7f4"
INK = "#1d1b18"
GLYPH = "#7fbfae"  # the § on an ink tablet

CINZEL_URL = (
    "https://raw.githubusercontent.com/google/fonts/"
    "e7db6ca603fd4862010383ff17ffd6cc4ffac1c0/ofl/cinzel/Cinzel%5Bwght%5D.ttf"
)
CINZEL_SHA256 = "f4d83d34d1f6c741193e4acf4b3dff9531e5a67b6aa65228d00a7db72a4e0f34"

WORDMARK = "stare.pub"

# The small drawing's §, one string per pixel row, in the body's columns 6 to 10 and
# rows 5 to 13 (the favicon's body is rows 4 to 14).
SECTION_PIXELS = (
    ".###.",
    "#....",
    ".##..",
    "#..#.",
    "#...#",
    ".#..#",
    "..##.",
    "....#",
    ".###.",
)
SECTION_X, SECTION_Y = 6, 5

# Cap and body of each drawing: (x, y, width, height).
SMALL_CAP, SMALL_BODY = (1, 0, 14, 2), (2, 3, 12, 13)
# The favicon draws the tablet a pixel smaller to fit its outline inside 16 px.
FAV_OUTLINE = ((0, 0, 16, 4), (1, 3, 14, 13))
FAV_CAP, FAV_BODY = (1, 1, 14, 2), (2, 4, 12, 11)
FULL_CAP, FULL_BODY = (2, 2, 36, 6), (5, 10, 30, 36)


def load_subset_fonts():
    spec = importlib.util.spec_from_file_location("subset_fonts", WEB / "scripts" / "subset-fonts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fetch_cinzel(cache: Path) -> bytes:
    path = cache / hashlib.sha256(CINZEL_URL.encode()).hexdigest()[:16]
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(CINZEL_URL) as r:  # noqa: S310 (a pinned https URL)
            path.write_bytes(r.read())
    data = path.read_bytes()
    got = hashlib.sha256(data).hexdigest()
    if got != CINZEL_SHA256:
        raise SystemExit(f"{CINZEL_URL}: SHA-256 {got}, expected {CINZEL_SHA256}")
    return data


def num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def outline(font: TTFont, text: str, size: float, x0: float, baseline: float):
    """SVG path data for `text` at `size` units, its pen starting at x0 on `baseline`.
    Returns (d, advance, (xmin, ymin, xmax, ymax)) in SVG coordinates."""
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    svg = SVGPathPen(gs, ntos=num)
    bounds = BoundsPen(gs)
    x = 0.0
    for ch in text:
        name = cmap[ord(ch)]
        # Font units are y-up; SVG is y-down.
        t = (scale, 0, 0, -scale, x0 + x * scale, baseline)
        gs[name].draw(TransformPen(svg, t))
        gs[name].draw(TransformPen(bounds, t))
        x += gs[name].width
    return svg.getCommands(), x * scale, bounds.bounds


def rect(r) -> str:
    x, y, w, h = r
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}"/>'


def section_rects() -> list[tuple[int, int, int, int]]:
    """The pixel §, as runs of pixels merged into rects."""
    out = []
    for dy, row in enumerate(SECTION_PIXELS):
        x = 0
        while x < len(row):
            if row[x] == "#":
                end = x
                while end + 1 < len(row) and row[end + 1] == "#":
                    end += 1
                out.append((SECTION_X + x, SECTION_Y + dy, end - x + 1, 1))
                x = end + 1
            else:
                x += 1
    return out


def small_body(cap, body, section_dy=0) -> str:
    sec = "".join(rect((x, y + section_dy, w, h)) for x, y, w, h in section_rects())
    return (
        f'<g class="mark-ink">{rect(cap)}{rect(body)}</g>'
        f'<g class="mark-glyph">{sec}</g>'
    )


def full_body(section_d: str) -> str:
    cap = '<rect x="2" y="2" width="36" height="6" rx="1"/>'
    body = '<rect x="5" y="10" width="30" height="36" rx="1"/>'
    return f'<g class="mark-ink">{cap}{body}</g><path class="mark-glyph" d="{section_d}"/>'


def favicon_svg() -> str:
    outline_rects = "".join(rect(r) for r in FAV_OUTLINE)
    sec = "".join(rect((x, y, w, h)) for x, y, w, h in section_rects())
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" '
        'shape-rendering="crispEdges">'
        f'<g fill="{GROUND}">{outline_rects}</g>'
        f'<g fill="{INK}">{rect(FAV_CAP)}{rect(FAV_BODY)}</g>'
        f'<g fill="{GLYPH}">{sec}</g>'
        "</svg>\n"
    )


def favicon_png(scale: int) -> Image.Image:
    img = Image.new("RGBA", (16 * scale, 16 * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def fill(r, colour):
        x, y, w, h = r
        d.rectangle([x * scale, y * scale, (x + w) * scale - 1, (y + h) * scale - 1], fill=colour)

    for r in FAV_OUTLINE:
        fill(r, GROUND)
    fill(FAV_CAP, INK)
    fill(FAV_BODY, INK)
    for r in section_rects():
        fill(r, GLYPH)
    return img


def touch_icon(serif: TTFont) -> Image.Image:
    """The full drawing, centred on the ground colour at 180 px (rendered at 4x, then
    reduced, for smooth edges)."""
    ss = 4
    size = 180 * ss
    img = Image.new("RGB", (size, size), GROUND)
    d = ImageDraw.Draw(img)
    # The 40 x 48 drawing at 3 px a unit is 120 x 144, centred.
    unit = 3 * ss
    ox, oy = (size - 40 * unit) / 2, (size - 48 * unit) / 2

    def box(r, radius):
        x, y, w, h = r
        d.rounded_rectangle(
            [ox + x * unit, oy + y * unit, ox + (x + w) * unit, oy + (y + h) * unit],
            radius=radius * unit,
            fill=INK,
        )

    box(FULL_CAP, 1)
    box(FULL_BODY, 1)
    # The §: the glyph outline, flattened to polygons.
    gs = serif.getGlyphSet()
    name = serif.getBestCmap()[ord("§")]
    rec = DecomposingRecordingPen(gs)
    gs[name].draw(rec)
    scale = 24 / serif["head"].unitsPerEm
    adv = gs[name].width * scale
    x0 = 20 - adv / 2
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    polys = _flatten(rec.value)

    def pt(p):
        return (ox + (x0 + p[0] * scale) * unit, oy + (36 - p[1] * scale) * unit)

    # Even-odd fill: draw each contour, XOR-ing into the mask.
    for poly in polys:
        layer = Image.new("L", (size, size), 0)
        ImageDraw.Draw(layer).polygon([pt(p) for p in poly], fill=255)
        mask = ImageChops.logical_xor(mask.convert("1"), layer.convert("1")).convert("L")
    img.paste(Image.new("RGB", (size, size), GLYPH), (0, 0), mask)
    return img.resize((180, 180), Image.LANCZOS)


def _flatten(ops, steps: int = 16) -> list[list[tuple[float, float]]]:
    """Recording-pen operations to polygons, curves sampled `steps` times."""
    polys, cur, last = [], [], None
    for op, args in ops:
        if op == "moveTo":
            cur = [args[0]]
            last = args[0]
        elif op == "lineTo":
            cur.append(args[0])
            last = args[0]
        elif op == "curveTo":
            p0 = last
            p1, p2, p3 = args[-3], args[-2], args[-1]
            for i in range(1, steps + 1):
                t = i / steps
                mt = 1 - t
                cur.append(
                    (
                        mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0],
                        mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1],
                    )
                )
            last = p3
        elif op == "qCurveTo":
            # TrueType quadratic splines: implied on-curve points between off-curve ones.
            pts = list(args)
            start = last
            offs, end = pts[:-1], pts[-1]
            segs = []
            for i, off in enumerate(offs):
                if i + 1 < len(offs):
                    nxt = ((off[0] + offs[i + 1][0]) / 2, (off[1] + offs[i + 1][1]) / 2)
                else:
                    nxt = end
                segs.append((start, off, nxt))
                start = nxt
            for a, c, b in segs:
                for i in range(1, steps + 1):
                    t = i / steps
                    mt = 1 - t
                    cur.append(
                        (
                            mt * mt * a[0] + 2 * mt * t * c[0] + t * t * b[0],
                            mt * mt * a[1] + 2 * mt * t * c[1] + t * t * b[1],
                        )
                    )
            last = end
        elif op in ("closePath", "endPath"):
            if cur:
                polys.append(cur)
            cur = []
    return polys


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache", type=Path, default=Path.home() / ".cache" / "stare-fonts")
    args = ap.parse_args()

    sf = load_subset_fonts()
    serif = TTFont(io.BytesIO(sf.read(args.cache, sf.Src("source-serif", sf._SS + "TTF/SourceSerif4-Regular.ttf"))))
    cinzel = TTFont(io.BytesIO(fetch_cinzel(args.cache)))
    cinzel = instancer.instantiateVariableFont(cinzel, {"wght": 500})

    # The § for the full drawing, centred on x 20 with its baseline at y 36.
    gs = serif.getGlyphSet()
    adv = gs[serif.getBestCmap()[ord("§")]].width * 24 / serif["head"].unitsPerEm
    section_d, _, _ = outline(serif, "§", 24, 20 - adv / 2, 36)

    # The wordmark at 100 units, cropped to its ink: the box's top is the letters' top
    # and its bottom the baseline, so the page can size it by its cap height.
    d0, _, (x0, y0, x1, y1) = outline(cinzel, WORDMARK, 100, 0, 0)
    word_d, _, _ = outline(cinzel, WORDMARK, 100, -x0, -y0)
    word_w, word_h = x1 - x0, y1 - y0

    js = f"""// Generated by web/scripts/marks.py; edit that, not this.
// stare.pub's § tablet (the Codex Publicus tablet, D112) and its Cinzel wordmark, for
// web/src/components/Brand.astro. The tablet's parts take their colours from CSS:
// .mark-ink (the tablet) and .mark-glyph (the §).

/** The full drawing, for 32 px and up. */
export const TABLET_FULL = {{
  viewBox: '0 0 40 48',
  body: '{full_body(section_d)}',
}};

/** The small drawing, on a 16 px grid, for 16 to 24 px. */
export const TABLET_SMALL = {{
  viewBox: '0 0 16 16',
  body: '{small_body(SMALL_CAP, SMALL_BODY)}',
}};

/** "{WORDMARK}" in Cinzel 500, cropped to its ink: top is the letters' height, bottom the baseline. */
export const WORDMARK = {{
  text: '{WORDMARK}',
  viewBox: '0 0 {num(word_w)} {num(word_h)}',
  aspect: {word_w / word_h:.4f},
  d: '{word_d}',
}};
"""
    (WEB / "src" / "lib" / "marks.js").write_text(js)
    (PUBLIC / "favicon.svg").write_text(favicon_svg())
    favicon_png(2).save(PUBLIC / "favicon-32.png", optimize=True)
    # Pillow writes each size from the image of that size in append_images, so the
    # 16 px entry is the pixel drawing itself, not the 32 px one scaled down.
    favicon_png(2).save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32)],
        append_images=[favicon_png(1)],
    )
    touch_icon(serif).save(PUBLIC / "apple-touch-icon.png", optimize=True)
    print(f"wordmark {num(word_w)} x {num(word_h)} (aspect {word_w / word_h:.3f})")


if __name__ == "__main__":
    main()
