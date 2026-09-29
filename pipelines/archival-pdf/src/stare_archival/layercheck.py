"""The exact check of a page's invisible text layer against its ALTO.

`layer_runs` reads what the content stream draws: each Tj run's text (the UTF-16BE code units
the Identity-H font maps one to one to Unicode), its start in page space, its font size, its
advance width and its render mode, tracking Tf, Tz, Tm, Tr, BT and q/Q/cm itself.
`expected_layer` works out, from the ALTO alone, the run the layer specification calls for per
word: the word's text (`textlayer.layer_text`), starting at the box's left edge, at the box's
height as the font size, with its baseline 85% of the way down the box, stretched to the box's
width. `compare_layer` requires the two to agree word for word: count, order, exact text,
render mode 3, and x0, baseline and size within 0.006 pt (the builder writes them to two
decimals), with the width's bound growing with the run, since Tz and the size are rounded too.
`check_layer_font` checks what gives the codes their meaning: one shared Type0 font, Identity-H,
the identity ToUnicode map, every CID drawing glyph 1, and glyph 1 half an em wide.
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from dataclasses import dataclass, field

import pikepdf
from fontTools.ttLib import TTFont, TTLibError

from stare_archival.alto import AltoPage
from stare_archival.textlayer import layer_text

# the layer's specification, restated here rather than imported from the builder
LAYER_FONT = "/F0"
LAYER_BASELINE = 0.85  # of the box height, down from its top
LAYER_GLYPH_EM = 0.5  # every glyph's advance
LAYER_RENDER_MODE = 3  # invisible
POSITION_TOLERANCE_PT = 0.006  # %.2f rounding of Tm and Tf, with float slack
ROUNDING = 0.005  # the largest error two-decimal rounding introduces
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
CID_TO_GID = b"\x00\x01" * 65536
UNMODELED_TEXT_OPERATORS = frozenset({"Tc", "Tw", "Ts", "TL", "Td", "TD", "T*", "TJ", "'", '"'})
FONT_UNITS_PER_EM = 1000
DEFAULT_WIDTH = 500


@dataclass(frozen=True)
class LayerRun:
    """One text run in page space (points, bottom-left origin): its text, where its first
    glyph starts, its baseline, font size, advance width and render mode."""

    text: str
    x0: float
    baseline: float
    size: float
    width: float
    render_mode: int


def concat(m: Sequence[float], n: Sequence[float]) -> tuple[float, ...]:
    """m x n for PDF's [a b c d e f] matrices (`m cm` applied to a CTM `n`)."""
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (
        a * a2 + b * c2,
        a * b2 + b * d2,
        c * a2 + d * c2,
        c * b2 + d * d2,
        e * a2 + f * c2 + e2,
        e * b2 + f * d2 + f2,
    )


def expected_layer(
    alto: AltoPage, *, page_height: float, dpi: tuple[float, float]
) -> list[LayerRun]:
    """The runs the text layer should draw for an ALTO page, in ALTO order."""
    runs = []
    for word in alto.words:
        text = layer_text(word)
        if not text:
            continue
        size = alto.to_points(word.height, dpi[1])
        top = alto.to_points(word.vpos, dpi[1])
        runs.append(
            LayerRun(
                text=text,
                x0=alto.to_points(word.hpos, dpi[0]),
                baseline=page_height - top - LAYER_BASELINE * size,
                size=size,
                width=alto.to_points(word.width, dpi[0]),
                render_mode=LAYER_RENDER_MODE,
            )
        )
    return runs


def layer_runs(page: pikepdf.Page) -> tuple[list[LayerRun], list[str]]:
    """The text runs a page draws, and anything about them that can't be read as a run.

    q/Q save and restore the CTM and the text state the layer uses (font, size, Tz, Tr), as
    they do in a viewer. Text operators the layer never writes (character and word spacing,
    rise, leading, Td/TD/T*, TJ, ' and ") and q/Q/cm inside BT are problems: the runs they'd
    draw aren't modelled here, so they can't be let through."""
    problems: list[str] = []
    runs: list[LayerRun] = []
    try:
        instructions = pikepdf.parse_content_stream(page)
    except pikepdf.PdfError as exc:
        return [], [f"content stream can't be parsed ({exc})"]
    # the graphics state q/Q saves: the CTM and the text state parameters the layer uses
    ctm: tuple[float, ...] = IDENTITY
    render_mode = 0
    font: str | None = None
    size = 0.0
    scale = 100.0
    saved: list[tuple] = []
    tm: tuple[float, ...] = IDENTITY
    in_text = False
    for operands, operator in instructions:
        op = str(operator)
        if op in UNMODELED_TEXT_OPERATORS:
            problems.append(f"the {op} operator isn't part of the text layer")
        elif op in ("q", "Q", "cm") and in_text:
            problems.append(f"{op} inside BT")
        elif op == "q":
            saved.append((ctm, render_mode, font, size, scale))
        elif op == "Q" and saved:
            ctm, render_mode, font, size, scale = saved.pop()
        elif op == "cm" and len(operands) == 6:
            ctm = concat([float(v) for v in operands], ctm)
        elif op == "BT":
            if in_text:
                problems.append("BT inside BT")
            in_text = True
            tm = IDENTITY
        elif op == "ET":
            in_text = False
        elif op == "Tf":
            font, size = str(operands[0]), float(operands[1])
        elif op == "Tz":
            scale = float(operands[0])
        elif op == "Tr":
            render_mode = int(operands[0])
        elif op == "Tm":
            tm = tuple(float(v) for v in operands)
        elif op == "Tj":
            data = bytes(operands[0])
            if not in_text:
                problems.append("Tj outside BT")
            if font != LAYER_FONT:
                problems.append(f"text drawn in font {font}, not {LAYER_FONT}")
            try:
                text = data.decode("utf-16-be")
            except UnicodeDecodeError:
                problems.append(f"a run's codes aren't UTF-16BE: {data.hex()}")
                continue
            m = concat(tm, ctm)
            if any(abs(a - b) > 1e-9 for a, b in zip(m[:4], IDENTITY[:4], strict=True)):
                problems.append(f"text drawn with matrix {[round(v, 4) for v in m]}")
            width = len(data) // 2 * LAYER_GLYPH_EM * size * scale / 100.0
            runs.append(LayerRun(text, m[4], m[5], size * m[3], width * m[0], render_mode))
            tm = (*tm[:4], tm[4] + width * tm[0], tm[5] + width * tm[1])
    return runs, list(dict.fromkeys(problems))


@dataclass(frozen=True)
class LayerResult:
    problems: list[str] = field(default_factory=list)
    max_position_deviation: float = 0.0
    max_width_deviation: float = 0.0


def width_bound(run: LayerRun) -> float:
    """How far a run's advance may be from its box width: Tz and the size are written to two
    decimals, and the Tz error grows with the number of glyphs."""
    glyphs = len(run.text.encode("utf-16-be")) // 2
    tz_error = glyphs * LAYER_GLYPH_EM * run.size * ROUNDING / 100.0
    size_error = run.width * ROUNDING / run.size if run.size > 0 else 0.0
    return POSITION_TOLERANCE_PT + tz_error + size_error


def _run_issue(want: LayerRun, got: LayerRun) -> tuple[str | None, float, float]:
    deviations = {
        "x0": abs(got.x0 - want.x0),
        "baseline": abs(got.baseline - want.baseline),
        "size": abs(got.size - want.size),
    }
    width_off = abs(got.width - want.width)
    position = max(deviations.values())
    if got.render_mode != LAYER_RENDER_MODE:
        return f"drawn in render mode {got.render_mode} (visible)", position, width_off
    for name, off in deviations.items():
        if off > POSITION_TOLERANCE_PT:
            return f"{name} is {off:.4f} pt off", position, width_off
    if width_off > width_bound(want):
        issue = f"width is {width_off:.4f} pt off (allowed {width_bound(want):.4f})"
        return issue, position, width_off
    return None, position, width_off


def compare_layer(want: Sequence[LayerRun], got: Sequence[LayerRun]) -> LayerResult:
    """Compare the runs a page draws with the runs its ALTO calls for. Problems name the
    first word whose text differs, the first word out of tolerance (and how many are), and a
    difference in the number of words."""
    problems: list[str] = []
    bad: list[tuple[int, str]] = []
    worst_position = worst_width = 0.0
    n = len(want)
    for i, (w, g) in enumerate(zip(want, got, strict=False)):
        if w.text != g.text:
            problems.append(
                f"word {i + 1} of {n}: the ALTO has {w.text!r}, the layer has {g.text!r}"
            )
            break
        issue, position, width_off = _run_issue(w, g)
        worst_position = max(worst_position, position)
        worst_width = max(worst_width, width_off)
        if issue:
            bad.append((i, issue))
    if bad:
        i, issue = bad[0]
        more = f"; {len(bad)} words are out of tolerance" if len(bad) > 1 else ""
        problems.insert(0, f"word {i + 1} of {n} ({want[i].text!r}): {issue}{more}")
    if len(got) != n:
        if len(got) < n:
            which = f"word {len(got) + 1} ({want[len(got)].text!r}) is missing"
        else:
            which = f"word {n + 1} ({got[n].text!r}) is extra"
        problems.append(f"the layer has {len(got)} words, the ALTO {n}; {which}")
    return LayerResult(problems, worst_position, worst_width)


def _font_program_problems(descriptor: pikepdf.Object) -> list[str]:
    program = descriptor.get("/FontFile2") if descriptor is not None else None
    if program is None:
        return ["the text layer font embeds no TrueType program (FontFile2)"]
    try:
        font = TTFont(io.BytesIO(program.read_bytes()))
        order = font.getGlyphOrder()
        units = font["head"].unitsPerEm
        advance = font["hmtx"][order[1]][0] if len(order) > 1 else None
    except (TTLibError, KeyError, IndexError, AssertionError, pikepdf.PdfError) as exc:
        return [f"the text layer font program can't be read ({exc})"]
    if units != FONT_UNITS_PER_EM or advance != LAYER_GLYPH_EM * FONT_UNITS_PER_EM:
        return [f"the font program's glyph 1 advances {advance} of {units} units, not 500/1000"]
    return []


_CODESPACE = re.compile(rb"\d+\s+begincodespacerange(.*?)endcodespacerange", re.S)
_BFRANGE = re.compile(rb"\d+\s+beginbfrange(.*?)endbfrange", re.S)
_HEX = re.compile(rb"<([0-9A-Fa-f]*)>")


def to_unicode_problem(cmap: bytes) -> str | None:
    """None when a ToUnicode CMap is the identity on 2-byte codes: one codespace range
    <0000> <FFFF>, one bfrange <0000> <FFFF> <0000>, and no bfchar or usecmap. Otherwise what
    differs."""
    spaces = [_HEX.findall(block) for block in _CODESPACE.findall(cmap)]
    if [[h.upper() for h in space] for space in spaces] != [[b"0000", b"FFFF"]]:
        return f"codespace is {spaces}, not <0000> <FFFF>"
    if b"beginbfchar" in cmap:
        return "has bfchar entries"
    if b"usecmap" in cmap:
        return "uses another CMap"
    ranges = [_HEX.findall(block) for block in _BFRANGE.findall(cmap)]
    if [[h.upper() for h in r] for r in ranges] != [[b"0000", b"FFFF", b"0000"]]:
        return f"bfrange is {ranges}, not <0000> <FFFF> <0000>"
    return None


def check_layer_font(pdf: pikepdf.Pdf) -> list[str]:
    """Problems with the text layer's font: pages must share one /F0 and have no other font,
    and that font must map codes to text and glyphs as the layer relies on."""
    problems: list[str] = []
    shared = None
    for number, page in enumerate(pdf.pages, start=1):
        fonts = page.resources.get("/Font")
        if fonts is None:
            continue
        for name in fonts.keys():  # noqa: SIM118 (a pikepdf Dictionary)
            if name != LAYER_FONT:
                problems.append(f"page {number} has a font {name}")
        font = fonts.get(LAYER_FONT)
        if font is None:
            continue
        if shared is None:
            shared = font
        elif font.objgen != shared.objgen or font.objgen == (0, 0):
            problems.append(f"page {number}: {LAYER_FONT} is not the shared text layer font")
    if shared is None:
        return problems
    if shared.get("/Subtype") != pikepdf.Name.Type0:
        problems.append("the text layer font is not Type0")
    if shared.get("/Encoding") != pikepdf.Name("/Identity-H"):
        problems.append(
            f"the text layer font's encoding is {shared.get('/Encoding')}, not Identity-H"
        )
    to_unicode = shared.get("/ToUnicode")
    if not isinstance(to_unicode, pikepdf.Stream):
        problems.append("the text layer font has no ToUnicode stream")
    else:
        problem = to_unicode_problem(to_unicode.read_bytes())
        if problem:
            problems.append(f"the text layer font's ToUnicode {problem}")
    descendants = shared.get("/DescendantFonts")
    if descendants is None or len(descendants) != 1:
        return [*problems, "the text layer font doesn't have exactly one descendant font"]
    cid = descendants[0]
    if cid.get("/Subtype") != pikepdf.Name.CIDFontType2:
        problems.append("the text layer's CID font is not CIDFontType2")
    if cid.get("/DW") != DEFAULT_WIDTH:
        problems.append(f"the text layer's CID font has DW {cid.get('/DW')}, not {DEFAULT_WIDTH}")
    if "/W" in cid:
        problems.append("the text layer's CID font has a /W array")
    cid_to_gid = cid.get("/CIDToGIDMap")
    if not isinstance(cid_to_gid, pikepdf.Stream) or cid_to_gid.read_bytes() != CID_TO_GID:
        problems.append("the text layer's CIDToGIDMap doesn't map every CID to glyph 1")
    problems += _font_program_problems(cid.get("/FontDescriptor"))
    return problems
