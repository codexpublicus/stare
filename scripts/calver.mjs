#!/usr/bin/env node
// Computes the next site release tag, vYYYY.MM.DD.N, from the UTC date and the
// existing tags. N is one more than the highest N already tagged that day, which
// equals "the day's tag count plus one" when the day's tags are contiguous and
// still yields an unused tag when one was deleted.
//
// CLI:
//   node scripts/calver.mjs [YYYY-MM-DD]
//     prints the next tag, reading existing tags from `git tag`; the date
//     defaults to today (UTC)
//   node scripts/calver.mjs --newest < tags
//     prints the newest release tag in a newline-separated list on stdin, or
//     nothing when there is none

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function calverDay(date) {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new Error(`invalid date: ${date}`);
  }
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

export function nextCalver(date, tags) {
  const day = calverDay(date);
  const pattern = new RegExp(`^v${day.replace(/\./g, '\\.')}\\.(\\d+)$`);
  let highest = 0;
  for (const tag of tags) {
    const match = pattern.exec(String(tag).trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `v${day}.${highest + 1}`;
}

const RELEASE_TAG = /^v(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

// The newest vYYYY.MM.DD.N in `tags`, compared field by field as numbers, or null.
export function newestCalver(tags) {
  const compare = (a, b) => a.findIndex((v, i) => v !== b[i]);
  let best = null;
  let bestKey = null;
  for (const raw of tags) {
    const tag = String(raw).trim();
    const m = RELEASE_TAG.exec(tag);
    if (!m) continue;
    const key = m.slice(1).map(Number);
    const i = bestKey ? compare(key, bestKey) : 0;
    if (!bestKey || (i >= 0 && key[i] > bestKey[i])) {
      best = tag;
      bestKey = key;
    }
  }
  return best;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--newest') {
    const newest = newestCalver(readFileSync(0, 'utf8').split('\n'));
    if (newest) process.stdout.write(`${newest}\n`);
  } else {
    const date = process.argv[2] ?? new Date();
    const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n');
    process.stdout.write(`${nextCalver(date, tags)}\n`);
  }
}
