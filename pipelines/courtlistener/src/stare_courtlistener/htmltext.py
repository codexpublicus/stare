"""Opinion HTML (and Harvard XML, and plain text) to CAP-style text.

CAP's opinion ``text`` is one paragraph per line, with ``\\n`` between paragraphs and no
blank lines. This module produces the same from each CourtListener text field:

- Block elements (``p``, ``div``, ``br``, headings, list items, table rows, ``blockquote``,
  and Harvard's ``author``, ``footnote``, ``parties`` and the like) end a paragraph. Every
  element not listed in ``INLINE`` counts as a block, so an unfamiliar XML tag breaks the
  line instead of gluing two paragraphs together.
- Inline elements keep their text and lose their markup. That includes CourtListener's
  citation anchors (``<span class="citation"><a href="/opinion/...">146 Ind. App. 223</a>
  </span>``): the citation's words stay, the link goes, since stare links citations itself.
- Whitespace inside a paragraph collapses to single spaces.
- ``pre`` blocks and ``plain_text`` are hard-wrapped text: a blank line separates
  paragraphs, and the lines within one are joined with spaces.
- ``script``, ``style`` and ``head`` are dropped with their contents. Character references
  are decoded.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser

INLINE = frozenset(
    {
        "a",
        "abbr",
        "b",
        "big",
        "bracketnum",
        "cite",
        "code",
        "del",
        "dfn",
        "em",
        "font",
        "footnotemark",
        "i",
        "ins",
        "kbd",
        "mark",
        "page-number",
        "q",
        "s",
        "samp",
        "small",
        "span",
        "strike",
        "strong",
        "sub",
        "sup",
        "tt",
        "u",
        "var",
        "extracted-citation",
    }
)
"""Elements whose text runs on in the surrounding paragraph."""

CELLS = frozenset({"td", "th"})
"""Table cells: separated by a space within their row."""

DROP = frozenset({"script", "style", "head", "title"})
"""Elements dropped with everything inside them."""

_SPACE = re.compile(r"\s+")
_BLANK_LINE = re.compile(r"\n[ \t\r\f\v]*\n")


def plain_paragraphs(text: str) -> list[str]:
    """Hard-wrapped text to paragraphs: split at blank lines, join each one's lines."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for block in _BLANK_LINE.split(text):
        para = _SPACE.sub(" ", block).strip()
        if para:
            out.append(para)
    return out


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paragraphs: list[str] = []
        self.current: list[str] = []
        self.dropping = 0
        self.pre = 0
        self.pre_text: list[str] = []

    def flush(self) -> None:
        para = _SPACE.sub(" ", "".join(self.current)).strip()
        if para:
            self.paragraphs.append(para)
        self.current = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:  # noqa: ARG002
        if tag in DROP:
            self.dropping += 1
        elif self.dropping:
            return
        elif tag == "pre":
            self.flush()
            self.pre += 1
        elif self.pre:
            if tag not in INLINE:
                self.pre_text.append("\n")
        elif tag in CELLS:
            self.current.append(" ")
        elif tag not in INLINE:
            self.flush()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag in DROP:
            self.dropping -= 1

    def handle_endtag(self, tag: str) -> None:
        if tag in DROP:
            self.dropping = max(0, self.dropping - 1)
        elif self.dropping:
            return
        elif tag == "pre" and self.pre:
            self.pre -= 1
            if not self.pre:
                self.paragraphs.extend(plain_paragraphs("".join(self.pre_text)))
                self.pre_text = []
        elif self.pre:
            if tag not in INLINE:
                self.pre_text.append("\n")
        elif tag in CELLS:
            self.current.append(" ")
        elif tag not in INLINE:
            self.flush()

    def handle_data(self, data: str) -> None:
        if self.dropping:
            return
        if self.pre:
            self.pre_text.append(data)
        else:
            self.current.append(data)

    def result(self) -> list[str]:
        self.close()
        if self.pre_text:
            self.paragraphs.extend(plain_paragraphs("".join(self.pre_text)))
            self.pre_text = []
        self.flush()
        return self.paragraphs


def html_paragraphs(html: str) -> list[str]:
    """The paragraphs of an HTML or Harvard XML opinion."""
    parser = _Text()
    parser.feed(html)
    return parser.result()


def to_text(value: str, field: str | None) -> str:
    """One text field's value as CAP-style text: paragraphs joined by ``\\n``."""
    if field == "plain_text":
        return "\n".join(plain_paragraphs(value))
    return "\n".join(html_paragraphs(value))
