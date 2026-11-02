// The search page's filter panel once facets.json is in (searchpage.js imports it when the
// filters first open, or a year range needs facets.json): the jurisdiction and court lists
// with each one's decisions, a box that narrows the court list, and the year range's
// chart of decisions a year with two sliders over it. The sliders are a pointer
// convenience over the From and To boxes, which hold the form's values and are what a
// keyboard reaches; the sliders are out of the tab order and hidden from screen readers.

import { yearBins } from './searchquery.js';

const num = (n) => Number(n || 0).toLocaleString('en-US');
const byName = (a, b) => (a.name || a.key).localeCompare(b.name || b.key);

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

/** A court's line in the list: `New York Court of Appeals, 1920–1959, 80 decisions`. */
export function courtLabel(c) {
  const years = c.years ? (c.years[0] === c.years[1] ? `, ${c.years[0]}` : `, ${c.years[0]}–${c.years[1]}`) : '';
  const count = c.decisions ? `, ${num(c.decisions)} ${c.decisions === 1 ? 'decision' : 'decisions'}` : '';
  return `${c.name || c.key}${years}${count}`;
}

/** A jurisdiction's line: `New York, 80 decisions`. */
export function jurisdictionLabel(j) {
  const count = j.decisions ? `, ${num(j.decisions)} ${j.decisions === 1 ? 'decision' : 'decisions'}` : '';
  return `${j.name || j.key}${count}`;
}

/**
 * The filter panel over `facets`: `els` holds the page's elements (jurisdiction, court,
 * courtFind, chart, from, to). Returns { fill(state) }, which sets the lists and the
 * chart for a state (the URL's, or the form's).
 */
export function mountFilters(facets, els) {
  const jurs = [...facets.jurisdictions].sort(byName);
  const courts = [...facets.courts].sort(byName);
  const allYears = facets.years.map((y) => y.key).sort();
  const span = (court) => {
    const c = court ? courts.find((x) => x.key === court) : null;
    return c?.years ?? [allYears[0], allYears[allYears.length - 1]];
  };

  function fillCourts(jur, court) {
    const find = els.courtFind.value.trim().toLowerCase();
    const shown = courts.filter((c) => c.key === court || ((!jur || c.jurisdiction === jur)
      && (!find || `${c.name} ${c.abbr || ''} ${c.key}`.toLowerCase().includes(find))));
    els.court.replaceChildren(option('', jur ? 'Any in this jurisdiction' : 'Any', !court),
      ...shown.map((c) => option(c.key, courtLabel(c), c.key === court)));
  }

  // The chart: one bar per bin, its height the bin's decisions on a square-root scale (so
  // a thin century still shows), the bins in the range marked; then the two sliders.
  const chart = els.chart;
  const bars = document.createElement('div');
  bars.className = 'search-year-bars';
  const lo = document.createElement('input');
  const hi = document.createElement('input');
  for (const r of [lo, hi]) {
    r.type = 'range';
    r.step = '1';
    r.tabIndex = -1;
    r.className = 'search-year-range';
  }
  const ends = document.createElement('div');
  ends.className = 'search-year-ends';
  chart.replaceChildren(bars, lo, hi, ends);
  chart.classList.add('search-year-chart-ready');
  let bins = [];
  let bounds = ['', ''];

  function drawChart(court) {
    bounds = span(court);
    bins = yearBins(facets.years, bounds[0], bounds[1]);
    const max = Math.max(1, ...bins.map((b) => b.decisions));
    bars.replaceChildren(...bins.map((b) => {
      const bar = document.createElement('span');
      bar.style.height = `${b.decisions ? Math.max(6, Math.round(100 * Math.sqrt(b.decisions / max))) : 0}%`;
      bar.title = `${b.from === b.to ? b.from : `${b.from}–${b.to}`}: ${num(b.decisions)}`;
      return bar;
    }));
    for (const r of [lo, hi]) {
      r.min = bounds[0];
      r.max = bounds[1];
      r.disabled = bounds[0] === bounds[1];
    }
    ends.replaceChildren(...bounds.map((y) => Object.assign(document.createElement('span'), { textContent: y })));
    syncFromBoxes();
  }

  // The boxes' years, clamped to the span, onto the sliders and the marked bars.
  function syncFromBoxes() {
    const f = /^\d{4}$/.test(els.from.value) ? els.from.value : bounds[0];
    const t = /^\d{4}$/.test(els.to.value) ? els.to.value : bounds[1];
    lo.value = String(Math.max(Number(bounds[0]), Math.min(Number(f), Number(bounds[1]))));
    hi.value = String(Math.min(Number(bounds[1]), Math.max(Number(t), Number(bounds[0]))));
    mark();
  }

  function mark() {
    const a = Math.min(Number(lo.value), Number(hi.value));
    const b = Math.max(Number(lo.value), Number(hi.value));
    bins.forEach((bin, i) => bars.children[i]?.classList.toggle('in', bin.to >= a && bin.from <= b));
  }

  // A slider moved: the boxes follow, an end at the span's edge left open.
  function onSlide() {
    let a = Number(lo.value);
    let b = Number(hi.value);
    if (a > b) [a, b] = [b, a];
    els.from.value = String(a) === bounds[0] ? '' : String(a);
    els.to.value = String(b) === bounds[1] ? '' : String(b);
    mark();
  }

  lo.addEventListener('input', onSlide);
  hi.addEventListener('input', onSlide);
  els.from.addEventListener('input', syncFromBoxes);
  els.to.addEventListener('input', syncFromBoxes);
  els.courtFind.hidden = false;
  els.courtFind.addEventListener('input', () => fillCourts(els.jurisdiction.value, els.court.value));
  els.court.addEventListener('change', () => drawChart(els.court.value));

  return {
    fill(state) {
      els.jurisdiction.replaceChildren(option('', 'Any', !state.jurisdiction),
        ...jurs.map((j) => option(j.key, jurisdictionLabel(j), j.key === state.jurisdiction)));
      fillCourts(state.jurisdiction, state.court);
      drawChart(state.court);
    },
    // The jurisdiction changed: the court list narrows to it, and a court elsewhere is
    // dropped.
    jurisdictionChanged() {
      const jur = els.jurisdiction.value;
      const court = courts.find((c) => c.key === els.court.value);
      const keep = court && (!jur || court.jurisdiction === jur) ? court.key : '';
      fillCourts(jur, keep);
      drawChart(keep);
    },
  };
}
