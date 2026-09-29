from datetime import UTC, datetime
from pathlib import Path

import pikepdf
import pytest
from fixture_paths import FIXTURES

from stare_archival.alto import parse_alto
from stare_archival.build import build_volume
from stare_archival.encoders import G4Encoder, read_tiff
from stare_archival.layercheck import (
    LayerRun,
    check_layer_font,
    compare_layer,
    expected_layer,
    layer_runs,
)
from stare_archival.tarindex import VolumeTar
from stare_archival.volume import load_volume

CREATED = datetime(2026, 9, 29, 12, 0, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def built(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("layer") / "152.pdf"
    build_volume(FIXTURES / "152.tar", None, out, G4Encoder(), created=CREATED)
    return out


def _expected(page_index: int) -> list[LayerRun]:
    with VolumeTar.open(FIXTURES / "152.tar") as vt:
        page = load_volume(vt).mets.pages[page_index]
        info = read_tiff(vt.read(page.tiff))
        if page.alto is None:
            return []
        alto = parse_alto(vt.read(page.alto), page.alto)
        return expected_layer(alto, page_height=info.page_size[1], dpi=info.dpi)


def test_the_built_layer_matches_the_alto_exactly(built):
    with pikepdf.open(built) as pdf:
        for i, page in enumerate(pdf.pages):
            want = _expected(i)
            got, problems = layer_runs(page)
            assert problems == []
            assert len(got) == len(want) == [0, 302, 251, 0][i]
            result = compare_layer(want, got)
            assert result.problems == [], result.problems
            assert result.max_position_deviation < 0.006
        assert check_layer_font(pdf) == []


def test_runs_decode_text_position_size_and_width(built):
    with pikepdf.open(built) as pdf:
        runs, _ = layer_runs(pdf.pages[1])
    first = runs[0]
    assert first.text == "839"
    assert first.render_mode == 3
    assert first.size > 0 and first.width > 0
    assert first.x0 == pytest.approx(_expected(1)[0].x0, abs=0.006)


def _run(text, x0=10.0, baseline=100.0, size=10.0, width=None):
    width = len(text) * 5.0 if width is None else width
    return LayerRun(text, x0, baseline, size, width, 3)


def test_compare_layer_names_the_first_differing_word():
    want = [_run("Bondy"), _run("v.", x0=50), _run("Pappas,", x0=60)]
    result = compare_layer(want, [_run("Bondy"), _run("v.", x0=50), _run("Pappas", x0=60)])
    (problem,) = result.problems
    assert problem == "word 3 of 3: the ALTO has 'Pappas,', the layer has 'Pappas'"


def test_compare_layer_reports_order_and_count():
    want = [_run("Bondy"), _run("v.", x0=50)]
    result = compare_layer(want, [_run("v.", x0=50), _run("Bondy")])
    assert result.problems[0] == "word 1 of 2: the ALTO has 'Bondy', the layer has 'v.'"
    result = compare_layer(want, [_run("Bondy")])
    assert result.problems == ["the layer has 1 words, the ALTO 2; word 2 ('v.') is missing"]


def test_compare_layer_tolerances():
    want = [_run("Bondy")]
    assert compare_layer(want, [_run("Bondy", x0=10.005)]).problems == []
    (problem,) = compare_layer(want, [_run("Bondy", x0=10.5)]).problems
    assert problem.startswith("word 1 of 1 ('Bondy'): x0 is 0.5000 pt off")
    (problem,) = compare_layer(want, [_run("Bondy", baseline=100.01)]).problems
    assert "baseline" in problem
    (problem,) = compare_layer(want, [_run("Bondy", size=10.1)]).problems
    assert "size" in problem
    (problem,) = compare_layer(want, [_run("Bondy", width=26.0)]).problems
    assert "width" in problem


def test_compare_layer_width_bound_grows_with_the_run():
    # Tz and the size are written to 2 decimals, so a long run's width may drift further
    long = "x" * 120
    want = [_run(long, size=5.0, width=300.0)]
    assert compare_layer(want, [_run(long, size=5.0, width=300.02)]).problems == []
    assert compare_layer(want, [_run(long, size=5.0, width=300.5)]).problems


def test_visible_text_is_a_layer_problem():
    run = LayerRun("Bondy", 10, 100, 10, 25, 0)
    (problem,) = compare_layer([_run("Bondy")], [run]).problems
    assert "render mode 0" in problem


def _with_font_edit(built: Path, dest: Path, edit) -> Path:
    with pikepdf.open(built) as pdf:
        font = pdf.pages[1].Resources.Font.F0
        edit(pdf, font)
        pdf.save(dest)
    return dest


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (
            lambda _pdf, f: f.ToUnicode.write(
                f.ToUnicode.read_bytes().replace(b"<0000> <FFFF> <0000>", b"<0000> <FFFF> <0001>")
            ),
            "ToUnicode",
        ),
        (lambda _pdf, f: setattr(f, "Encoding", pikepdf.Name("/Identity-V")), "Identity-H"),
        (lambda _pdf, f: setattr(f.DescendantFonts[0], "DW", 600), "DW"),
        (
            lambda _pdf, f: f.DescendantFonts[0].CIDToGIDMap.write(b"\x00\x02" * 65536),
            "CIDToGIDMap",
        ),
        (
            lambda _pdf, f: setattr(f.DescendantFonts[0], "W", pikepdf.Array([0, [700]])),
            "/W",
        ),
    ],
)
def test_font_changes_are_layer_problems(built, tmp_path, edit, message):
    path = _with_font_edit(built, tmp_path / "f.pdf", edit)
    with pikepdf.open(path) as pdf:
        problems = check_layer_font(pdf)
    assert any(message in p for p in problems), problems


def test_a_second_font_is_a_layer_problem(built, tmp_path):
    def add_copy(pdf, font):
        copy = pdf.make_indirect(pikepdf.Dictionary(dict(font.items())))
        pdf.pages[2].Resources.Font.F0 = copy

    path = _with_font_edit(built, tmp_path / "f.pdf", add_copy)
    with pikepdf.open(path) as pdf:
        problems = check_layer_font(pdf)
    assert any("not the shared text layer font" in p for p in problems), problems
