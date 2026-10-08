// Page anchors in the case view (#124). The case JSON's opinion text has no
// page breaks; CAP's HTML for the case, in the same volume zip, marks each
// one with `<a class="page-label" data-label="1023">*1023</a>`. These are
// found in the HTML, placed in the opinion text by matching the words that
// follow them, and shown in the reader as `[*1023]` markers with the id
// `page-1023`, which the router scrolls to.

// Elements that end a run of text; a space is put after each so the words
// on either side don't run together.
const BLOCKS = new Set(['P', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BR', 'TABLE', 'TR', 'TD', 'TH']);

// How much of the text after a page break is matched to place it, and the
// shorter match tried when that fails.
const SNIPPET = 40;
const SHORT_SNIPPET = 16;

/**
 * Text with every run of whitespace made one space and leading whitespace
 * dropped, and for each character of the result its UTF-16 index in `text`.
 */
export function normalizeText(text) {
  let out = '';
  const at = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (out && !out.endsWith(' ')) { out += ' '; at.push(i); }
    } else {
      out += ch;
      at.push(i);
    }
  }
  return { text: out, at };
}

// Appends text to a stream as normalizeText would.
function append(stream, text) {
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (stream.text && !stream.text.endsWith(' ')) stream.text += ' ';
    } else {
      stream.text += ch;
    }
  }
}

function walk(node, stream) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      append(stream, child.nodeValue);
    } else if (child.nodeType === 1) {
      if (child.classList.contains('page-label')) {
        const page = child.getAttribute('data-label');
        if (page) stream.labels.push({ page, at: stream.text.length });
        continue;
      }
      walk(child, stream);
      if (BLOCKS.has(child.tagName)) append(stream, ' ');
    }
  }
}

/**
 * The opinions in a parsed CAP case HTML document, in order, each as
 * `{ text, labels }`: its text, normalized as normalizeText does, without
 * the page labels, and each label as `{ page, at }`, `at` an index into
 * that text. A label before the first opinion (in the head matter) is a
 * page the first opinion starts on, so it is put at that opinion's start.
 */
export function opinionStreams(doc) {
  const articles = [...doc.querySelectorAll('article.opinion')];
  const streams = articles.map(a => {
    const s = { text: '', labels: [] };
    walk(a, s);
    return s;
  });
  if (streams.length) {
    const first = articles[0];
    const before = [...doc.querySelectorAll('.page-label')]
      .filter(el => first.compareDocumentPosition(el) & 2 /* PRECEDING */ && !first.contains(el))
      .map(el => ({ page: el.getAttribute('data-label'), at: 0 }))
      .filter(l => l.page);
    streams[0].labels.unshift(...before);
  }
  return streams;
}

/**
 * Where each label of `stream` (from opinionStreams) falls in `text`, the
 * opinion's text from the case JSON: `[{ page, offset }]`, `offset` a
 * UTF-16 index into `text`, in order. Each is placed by finding the words
 * after it, searching on from the last one placed; a label whose words
 * can't be found is left out.
 */
export function locatePageBreaks(stream, text) {
  const norm = normalizeText(text);
  const breaks = [];
  let from = 0;
  for (const { page, at } of stream.labels) {
    const after = stream.text.slice(at).trimStart();
    if (at === 0 || !after) {
      if (at === 0) breaks.push({ page, offset: 0 });
      continue;
    }
    let found = norm.text.indexOf(after.slice(0, SNIPPET), from);
    if (found < 0) found = norm.text.indexOf(after.slice(0, SHORT_SNIPPET), from);
    if (found < 0) continue;
    breaks.push({ page, offset: norm.at[found] });
    from = found;
  }
  return breaks;
}

/**
 * The page breaks in each opinion of a case, from its CAP HTML, as the
 * reader places them: `[{ page, paragraph, offset }]` per opinion, with
 * `paragraph` an index into the paragraphs renderTextHtml makes and
 * `offset` a UTF-16 index into that paragraph's text. `parse` turns HTML
 * into a document (DOMParser in the browser); injectable for tests. Empty
 * lists when the HTML has none.
 */
export function pageBreaks(html, opinions, parse = (h) => new DOMParser().parseFromString(h, 'text/html')) {
  const streams = opinionStreams(parse(html));
  return opinions.map((op, i) => {
    if (!streams[i]) return [];
    const text = op.text || '';
    return locatePageBreaks(streams[i], text)
      .map(b => ({ page: b.page, ...paragraphPosition(text, b.offset) }))
      .filter(b => Number.isInteger(b.paragraph));
  });
}

/**
 * For an offset into an opinion's text, the paragraph it is in and the
 * offset in that paragraph, with paragraphs split as renderTextHtml splits
 * them (on runs of newlines, blank ones dropped). An offset in a break
 * goes to the start of the next paragraph. Null past the last one.
 */
export function paragraphPosition(text, offset) {
  const breaks = /\n+/g;
  let from = 0;
  let index = 0;
  for (;;) {
    const m = breaks.exec(text);
    const to = m ? m.index : text.length;
    if (text.slice(from, to).trim()) {
      if (offset < to) return { paragraph: index, offset: Math.max(0, offset - from) };
      index++;
    }
    if (!m) return null;
    from = breaks.lastIndex;
  }
}

function markerElement(doc, page) {
  const el = doc.createElement('span');
  el.className = 'page-marker';
  el.id = `page-${page}`;
  el.dataset.page = page;
  el.textContent = `[*${page}]`;
  return el;
}

// Puts `marker` at UTF-16 offset `offset` in paragraph element `p`'s text,
// before any link the offset falls inside.
function insertAt(p, offset, marker) {
  const doc = p.ownerDocument;
  const walker = doc.createTreeWalker(p, 4 /* SHOW_TEXT */);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue.length;
    if (offset < seen + len) {
      const link = node.parentElement.closest('a');
      if (link && p.contains(link)) {
        link.before(marker);
      } else {
        node.splitText(offset - seen).before(marker);
      }
      return;
    }
    seen += len;
  }
  p.append(marker);
}

/**
 * Put page markers in a rendered reader (renderReader's container):
 * `breaks` is pageBreaks' result. Markers already in the
 * text (`[*1023]` in the opinion text itself) get the same id, when no
 * other marker has it.
 */
export function insertPageMarkers(container, breaks) {
  const opinions = container.querySelectorAll('.reader-text');
  (breaks || []).forEach((list, i) => {
    const el = opinions[i];
    if (!el || !list?.length) return;
    const paragraphs = el.querySelectorAll(':scope > p');
    // Last first, so earlier offsets in the same paragraph stay valid.
    const placed = list
      .filter(b => paragraphs[b.paragraph])
      .sort((a, b) => b.paragraph - a.paragraph || b.offset - a.offset);
    for (const b of placed) {
      if (pageMarker(container, b.page)) continue;
      insertAt(paragraphs[b.paragraph], b.offset, markerElement(container.ownerDocument, b.page));
    }
  });
  for (const m of container.querySelectorAll('.page-marker:not([id])')) {
    const page = m.textContent.match(/^\[\*(\d+)\]$/)?.[1];
    if (page && !pageMarker(container, page)) {
      m.id = `page-${page}`;
      m.dataset.page = page;
    }
  }
}

/** The marker for `page` in a rendered reader, or null. */
export function pageMarker(container, page) {
  if (page == null) return null;
  return container.querySelector(`[id="page-${String(page).replace(/["\\]/g, '')}"]`);
}
