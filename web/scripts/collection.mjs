// Reads the collection's figures from the live index and writes everything that
// states them (#297):
//
// - src/data/collection.json, which the pages and the JSON-LD read;
// - public/llms.txt's summary, the line after its title;
// - public/og-image.svg, and public/og-image.png rendered from it in Playwright's
//   Chromium with the SVG's SHA-256 recorded in the PNG. Only when the SVG changes,
//   so a build whose figures haven't moved needs no browser.
//
// `npm --prefix web run build` runs it first (the prebuild script) and fails if the
// index can't be read, rather than ship the snapshot in git. Run it by hand to bring
// that snapshot up to date:
//
//   npm --prefix web run collection
//
// --index <url> reads another index host (default https://idx.stare.pub).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { readCollection } from '../src/lib/collection-read.js';
import { figures } from '../src/lib/collection-figures.js';
import { pngTextChunks, withPngText } from './png-text.mjs';

const dataPath = new URL('../src/data/collection.json', import.meta.url);
const llmsPath = new URL('../public/llms.txt', import.meta.url);
const svgPath = new URL('../public/og-image.svg', import.meta.url);
const pngPath = new URL('../public/og-image.png', import.meta.url);

export function ogSvg(ogLine) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#1a1a1a"/>
  <text x="600" y="240" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="120" fill="#f8f7f4">§tare.pub</text>
  <text x="600" y="340" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="36" fill="#888">Free, open U.S. case law lookup</text>
  <text x="600" y="430" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="24" fill="#666">${ogLine}</text>
</svg>
`;
}

// llms.txt with its summary (the "> " line after the title) replaced.
export function withLlmsSummary(text, summary) {
  const lines = text.split('\n');
  const at = lines.findIndex((l, i) => i > 0 && l.startsWith('> '));
  if (at < 0 || lines.slice(1, at).some((l) => l.trim())) {
    throw new Error('llms.txt: no "> " summary line after the title');
  }
  lines[at] = summary;
  return lines.join('\n');
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function renderPng(svg) {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch (err) {
    throw new Error(`og-image.png needs Playwright's Chromium (npm --prefix web ci): ${err.message}`);
  }
  const browser = await chromium.launch().catch((err) => {
    throw new Error(`og-image.png needs Playwright's Chromium (web/node_modules/.bin/playwright install --only-shell chromium): ${err.message}`);
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#1a1a1a}svg{display:block}</style>${svg}`,
    );
    const png = await page.screenshot({ type: 'png', omitBackground: false });
    return withPngText(png, 'stare:source-sha256', sha256(svg));
  } finally {
    await browser.close();
  }
}

async function main() {
  const { values } = parseArgs({ options: { index: { type: 'string', default: 'https://idx.stare.pub' } } });
  const collection = await readCollection({ index: values.index });
  const f = figures(collection);

  writeFileSync(dataPath, `${JSON.stringify(collection, null, 2)}\n`);
  writeFileSync(llmsPath, withLlmsSummary(readFileSync(llmsPath, 'utf8'), f.llmsSummary));

  const svg = ogSvg(f.ogLine);
  const png = readFileSync(pngPath);
  if (pngTextChunks(png)['stare:source-sha256'] !== sha256(svg)) {
    writeFileSync(svgPath, svg);
    writeFileSync(pngPath, await renderPng(svg));
    console.log('collection: rendered og-image.svg and og-image.png');
  }
  for (const { year, decisions } of collection.years_ignored) {
    console.warn(`collection: left out ${decisions} decision(s) dated ${year}, after the CourtListener export of ${collection.courtlistener.export}`);
  }
  console.log(`collection: ${f.coverage} (index ${collection.index_version})`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
