// Writes public/og-image.svg from src/data/collection.json and renders
// public/og-image.png from it in Playwright's Chromium, recording the SVG's
// SHA-256 in the PNG. Run after changing the collection's figures:
//
//   npm --prefix web run og-image
//
// web/tests/collection.test.js fails until you do.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

import { casesLabel, yearRange } from '../src/lib/collection.js';
import { withPngText } from './png-text.mjs';

const svgPath = new URL('../public/og-image.svg', import.meta.url);
const pngPath = new URL('../public/og-image.png', import.meta.url);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#1a1a1a"/>
  <text x="600" y="240" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="120" fill="#f8f7f4">§tare.pub</text>
  <text x="600" y="340" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="36" fill="#888">Free, open U.S. case law lookup</text>
  <text x="600" y="430" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="24" fill="#666">${casesLabel} · ${yearRange} · Serverless. Actually.</text>
</svg>
`;

writeFileSync(svgPath, svg);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#1a1a1a}svg{display:block}</style>${readFileSync(svgPath, 'utf8')}`,
  );
  const png = await page.screenshot({ type: 'png', omitBackground: false });
  const sha = createHash('sha256').update(readFileSync(svgPath)).digest('hex');
  writeFileSync(pngPath, withPngText(png, 'stare:source-sha256', sha));
} finally {
  await browser.close();
}
console.log(`wrote og-image.svg and og-image.png: ${casesLabel} · ${yearRange}`);
