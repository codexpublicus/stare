"""HTML, Harvard XML and plain text to CAP-style text, on real fields from the 2026-09-30
export (``fixtures/text/<opinion id>-<field>``, each cut at a paragraph end)."""

from pathlib import Path

import pytest

from stare_courtlistener.htmltext import html_paragraphs, plain_paragraphs, to_text

TEXT = Path(__file__).parent / "fixtures" / "text"


def _fixture(name: str) -> str:
    return (TEXT / name).read_text(encoding="utf-8")


def test_citation_anchors_drop_but_their_words_stay() -> None:
    html = _fixture("7070920-html_with_citations.html")
    assert '<a href="/opinion/2240912/' in html
    text = to_text(html, "html_with_citations")
    assert "/opinion/" not in text and "<" not in text
    assert "(1969), 146 Ind. App. 223, 253 N.E.2d 739, 20 Ind. Dec. 21, in which" in text
    lines = text.split("\n")
    assert lines[0] == "White, J."
    assert lines[1].startswith("This case is a sequel to O’Banion v. State ex rel. Shively")


def test_harvard_xml_keeps_one_paragraph_per_line() -> None:
    text = to_text(_fixture("7090799-xml_harvard.xml"), "xml_harvard")
    lines = text.split("\n")
    assert lines[:2] == ["Opinion by", "Williams, C. J."]
    assert lines[2].startswith("Lewis J. Mason filed his bill")
    assert "" not in lines


def test_lawbox_headings_and_star_pages() -> None:
    lines = to_text(_fixture("153055-html_lawbox.html"), "html_lawbox").split("\n")
    assert lines[:4] == [
        "613 F.3d 1344 (2010)",
        "UNITED STATES of America, Plaintiff-Appellee,",
        "v.",
        "Victor Garcia VILLARREAL, Defendant-Appellant.",
    ]
    assert "BACKGROUND" in lines
    assert any(line.startswith("*1347 Michael McCrum, Thompson & Knight LLP") for line in lines)
    assert "*1348 Before TJOFLAT, WILSON and EBEL,[*] Circuit Judges." in lines


def test_scraped_html_tables_and_line_breaks() -> None:
    lines = to_text(_fixture("11066776-html.html"), "html").split("\n")
    assert lines[:3] == [
        "People v Clyburn (2025 NY Slip Op 03464)",
        "People v Clyburn",
        "2025 NY Slip Op 03464",
    ]
    i = lines.index("[*1]THE PEOPLE OF THE STATE OF NEW YORK, RESPONDENT,")
    assert lines[i + 1 : i + 3] == ["v", "RODNEY CLYBURN, DEFENDANT-APPELLANT."]


def test_columbia_paragraphs() -> None:
    lines = to_text(_fixture("3752876-html_columbia.html"), "html_columbia").split("\n")
    assert lines[1] == "The building code was enacted November 19, 1951."
    assert lines[3].endswith("include trailers. *Page 142")


def test_plain_text_joins_wrapped_lines() -> None:
    lines = to_text(_fixture("11066501-plain_text.txt"), "plain_text").split("\n")
    assert "NOTE: This order is nonprecedential." in lines
    assert "The parties having so agreed, it is ordered that:" in lines
    assert "(2) Each side shall bear their own costs." in lines


@pytest.mark.parametrize(
    ("html", "expected"),
    [
        ("<p>a&amp;b &#x27;c&#x27;</p>", ["a&b 'c'"]),
        ("<p>one<br>two<br/>three</p>", ["one", "two", "three"]),
        ("<p>x</p><script>var a = '<p>no</p>';</script><style>p{}</style><p>y</p>", ["x", "y"]),
        (
            "<div>a <em>b</em> <span class='citation'><a href='/x'>1 U.S. 1</a></span></div>",
            ["a b 1 U.S. 1"],
        ),
        ("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>", ["a b", "c"]),
        (
            "<pre>line one\ncontinues\n\n  next para\n</pre><p>after</p>",
            ["line one continues", "next para", "after"],
        ),
        ("<opinion><unknown>a</unknown>b</opinion>", ["a", "b"]),
        ("text <footnotemark>1</footnotemark> more", ["text 1 more"]),
        ("", []),
    ],
)
def test_html_paragraphs(html: str, expected: list[str]) -> None:
    assert html_paragraphs(html) == expected


def test_plain_paragraphs_handles_carriage_returns() -> None:
    assert plain_paragraphs("a\r\nb\r\n\r\nc\rd") == ["a b", "c d"]
