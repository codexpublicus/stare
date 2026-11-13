// The case details on a phone (D214): at 768 px and under, the sidebar is a bottom sheet.
// A bar at the foot of the case view says what's in it ("12 cited cases · 2 other
// printings") and opens it; the sheet opens at half the window's height, a button or a drag
// takes it to the full height, and a drag down, the scrim, Escape or its Close button shuts
// it. The sidebar's own content is the sheet's, moved by CSS alone (layout.css): nothing is
// rendered twice, and over 768 px the sheet's parts are hidden and the sidebar is the
// sidebar again.
//
// Opened, the sheet is a modal dialog: the focus moves into it, Tab stays in it, the rest of
// the case view is inert, and closing it puts the focus back on the bar (#270's guarantees
// for the sidebar toggle it replaces).

export const SHEET_QUERY = '(max-width: 768px)';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The bar's text from the sheet's counts: `cited`, the cited cases listed, and `others`, the
 * other printings and sources, each null while it's still being found (or when finding it
 * failed). A count of none is left out; with nothing to count, the bar says "Case details".
 */
export function sheetSummary({ cited = null, others = null } = {}) {
  const parts = [];
  if (cited > 0) parts.push(plural(cited, 'cited case', 'cited cases'));
  if (others > 0) parts.push(plural(others, 'other printing', 'other printings'));
  return parts.length ? parts.join(' · ') : 'Case details';
}

// A drag faster than this (px/ms) goes on to the next size in its direction.
const FLICK = 0.5;

/**
 * Where a drag of the sheet settles: 'closed', 'half' or 'full', from the height it was let
 * go at, how fast it was moving (px/ms, up positive) and the two open heights. A flick goes
 * to the next size in its direction; otherwise the nearest size wins, and anything under
 * half of the half height closes. When the window is too short for two sizes, `half` equals
 * `full` and there is only 'full'.
 */
export function snapSize(height, velocity, { half, full }) {
  const two = half < full;
  if (velocity > FLICK) return !two || height >= half ? 'full' : 'half';
  if (velocity < -FLICK) {
    if (two && height > half) return 'half';
    return 'closed';
  }
  if (height < half / 2) return 'closed';
  if (!two) return 'full';
  return height < (half + full) / 2 ? 'half' : 'full';
}

// Pointer movement under this many pixels is a tap, not a drag.
const SLOP = 8;

// Tracks a vertical drag on `el`: `start()` when the pointer has moved past the slop,
// `move(dy)` as it goes (dy up positive), `end(dy, velocity)` when it's let go. A drag
// swallows the click that would follow it, so a drag on a button doesn't press it.
function trackDrag(el, { start, move, end }) {
  let down = null;
  let dragging = false;
  let swallow = false;
  let samples = [];
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { id: e.pointerId, y: e.clientY };
    dragging = false;
    samples = [{ t: e.timeStamp, y: e.clientY }];
  });
  // Followed on the document, so a mouse that leaves the element before the drag starts is
  // still followed (a touch stays with its element); held once dragging, so a press that
  // turns out to be a tap still clicks the button under it.
  const doc = el.ownerDocument;
  doc.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dy = down.y - e.clientY;
    if (!dragging) {
      if (Math.abs(dy) < SLOP) return;
      dragging = true;
      try { el.setPointerCapture(e.pointerId); } catch { /* the pointer has gone */ }
      start();
    }
    samples.push({ t: e.timeStamp, y: e.clientY });
    if (samples.length > 5) samples.shift();
    move(dy);
  });
  const finish = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dy = down.y - e.clientY;
    down = null;
    if (!dragging) return;
    dragging = false;
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
    const first = samples[0];
    const dt = e.timeStamp - first.t;
    end(dy, dt > 0 ? (first.y - e.clientY) / dt : 0);
  };
  doc.addEventListener('pointerup', finish);
  doc.addEventListener('pointercancel', finish);
  el.addEventListener('click', (e) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]';

/**
 * Wire the sheet. `bar` is the button that opens it, `sheet` the sheet (its head and the
 * sidebar), `head` the head that drags it, `sizeBtn` and `closeBtn` the head's buttons,
 * `scrim` the shade behind it, and `inert` the elements made inert while it's open. Returns
 * `{ open(size), close(opts), setCounts(counts), isOpen() }`; setCounts takes the counts
 * sheetSummary does, merged into those already set (`setCounts(null)` clears them).
 */
export function attachSheet({ bar, sheet, head, sizeBtn, closeBtn, scrim, inert = [], win = window }) {
  const doc = sheet.ownerDocument;
  const barText = bar.querySelector('.sheet-bar-text') || bar;
  const query = win.matchMedia(SHEET_QUERY);
  let counts = {};
  let size = 'closed';

  // The two open heights, in pixels, as layout.css sets them.
  const heights = () => {
    const probe = (s) => {
      const was = sheet.dataset.size;
      sheet.classList.add('sheet-measure');
      sheet.dataset.size = s;
      const h = sheet.getBoundingClientRect().height;
      sheet.dataset.size = was;
      sheet.classList.remove('sheet-measure');
      return h;
    };
    return { half: probe('half'), full: probe('full') };
  };

  function setSize(next, { focus = true } = {}) {
    const was = size;
    size = next;
    // A sheet dragged shut slides away at the height it was let go at.
    if (next !== 'closed') sheet.style.removeProperty('height');
    else setTimeout(() => { if (size === 'closed') sheet.style.removeProperty('height'); }, 400);
    sheet.dataset.size = next;
    const open = next !== 'closed';
    bar.setAttribute('aria-expanded', String(open));
    scrim.classList.toggle('open', open);
    // The size button names what it does next.
    sizeBtn.textContent = next === 'full' ? 'Shrink' : 'Expand';
    if (open) {
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-labelledby', 'sheet-title');
      for (const el of inert) el.inert = true;
      if (was === 'closed' && focus) sheet.focus({ preventScroll: true });
    } else if (was !== 'closed') {
      sheet.removeAttribute('role');
      sheet.removeAttribute('aria-modal');
      sheet.removeAttribute('aria-labelledby');
      for (const el of inert) el.inert = false;
      if (focus) bar.focus({ preventScroll: true });
    }
  }

  const open = (to = 'half') => setSize(to);
  const close = (opts) => setSize('closed', opts);

  bar.addEventListener('click', () => {
    if (size === 'closed') open('half');
    else close();
  });
  sizeBtn.addEventListener('click', () => setSize(size === 'full' ? 'half' : 'full'));
  closeBtn.addEventListener('click', () => close());
  scrim.addEventListener('click', () => close());

  // Dragging: the bar up opens the sheet under the finger, the head moves it either way, and
  // letting go settles it at the nearest size (snapSize).
  let from = 0;
  let limits = null;
  const follow = (h) => {
    const height = Math.max(0, Math.min(limits.full, h));
    sheet.style.height = `${height}px`;
    return height;
  };
  const dragStart = (base) => () => {
    limits = heights();
    from = base();
    sheet.classList.add('sheet-dragging');
    if (size === 'closed') {
      // Shown at no height, then grown by the drag.
      sheet.dataset.size = 'drag';
      scrim.classList.add('open');
    }
  };
  const dragEnd = (dy, velocity) => {
    const height = follow(from + dy);
    sheet.classList.remove('sheet-dragging');
    const next = snapSize(height, velocity, limits);
    if (next === 'closed' && size === 'closed') {
      sheet.style.removeProperty('height');
      sheet.dataset.size = 'closed';
      scrim.classList.remove('open');
      return;
    }
    // From the dragged height to the settled one, animated (layout.css).
    void sheet.offsetHeight;
    setSize(next);
  };
  trackDrag(bar, { start: dragStart(() => 0), move: (dy) => follow(from + dy), end: dragEnd });
  trackDrag(head, {
    start: dragStart(() => sheet.getBoundingClientRect().height),
    move: (dy) => follow(from + dy),
    end: dragEnd,
  });

  // A link that leaves for another case or place closes the sheet; one opening a new tab
  // doesn't.
  sheet.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || a.target === '_blank' || size === 'closed') return;
    close({ focus: false });
  });

  doc.addEventListener('keydown', (e) => {
    if (size === 'closed' || !query.matches) return;
    if (e.key === 'Escape') {
      // The cited-cases filter's own Escape clears it first.
      if (e.defaultPrevented) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length);
    if (!stops.length) return;
    const i = stops.indexOf(doc.activeElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      stops[stops.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === stops.length - 1)) {
      e.preventDefault();
      stops[0].focus();
    }
  });

  // Wider than a phone, the sidebar is the sidebar again: an open sheet closes, leaving the
  // focus where it is.
  query.addEventListener('change', () => {
    if (!query.matches && size !== 'closed') close({ focus: false });
  });

  return {
    open,
    close,
    isOpen: () => size !== 'closed',
    setCounts(next) {
      counts = next ? { ...counts, ...next } : {};
      barText.textContent = sheetSummary(counts);
    },
  };
}
