// AA contrast for the theme's text colours (#257): every pair below is text the site
// draws on that background, in light and in dark; and the focus ring at 3:1 (#270).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/styles/theme.css'), 'utf8');

function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, selector);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background]
const PAIRS = [
  ...['text', 'text-body', 'text-secondary', 'text-tertiary', 'link', 'cite', 'cite-hover', 'unresolved',
    'footnote-text', 'sidebar-action', 'status-text'].flatMap((t) => [[t, 'bg'], [t, 'bg-alt']]),
  ['topbar-text', 'topbar-bg'], ['topbar-muted', 'topbar-bg'], ['topbar-cite', 'topbar-bg'],
  ['cite-badge-text', 'cite-badge-bg'], ['cite-badge-primary-text', 'cite-badge-primary-bg'],
  ['error-text', 'error-bg'], ['status-text', 'status-bg'], ['link', 'status-bg'],
  ['button-text', 'button-bg'], ['tooltip-text', 'tooltip-bg'],
];

for (const [name, selector] of [['light', ':root'], ['dark', '[data-theme="dark"]']]) {
  describe(`${name} theme`, () => {
    const t = { ...tokens(':root'), ...(selector === ':root' ? {} : tokens(selector)) };
    for (const [fg, bg] of PAIRS) {
      test(`--${fg} on --${bg} is at least 4.5:1`, () => {
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(ratio >= 4.5, `${t[fg]} on ${t[bg]}: ${ratio.toFixed(2)}`);
      });
    }
    // The focus ring (#270) is a non-text indicator: 3:1 against every ground it's drawn on
    // (WCAG 1.4.11), and the error notice's ring against the notice.
    for (const [ring, bg] of [['focus', 'bg'], ['focus', 'bg-alt'], ['focus', 'bg-surface'], ['focus', 'topbar-bg'],
      ['focus', 'status-bg'], ['error-text', 'error-bg']]) {
      test(`the focus ring --${ring} on --${bg} is at least 3:1`, () => {
        const ratio = contrast(t[ring], t[bg]);
        assert.ok(ratio >= 3, `${t[ring]} on ${t[bg]}: ${ratio.toFixed(2)}`);
      });
    }
    test('the § on the tablet is at least 3:1', () => {
      assert.ok(contrast(t['mark-glyph'], t['mark-ink']) >= 3);
    });
  });
}
