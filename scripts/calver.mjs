#!/usr/bin/env node
// Computes the next site release tag, vYYYY.MM.DD.N, from the UTC date and the
// existing tags. N is one more than the highest N already tagged that day, which
// equals "the day's tag count plus one" when the day's tags are contiguous and
// still yields an unused tag when one was deleted.
//
// CLI: node scripts/calver.mjs [YYYY-MM-DD]
// prints the next tag, reading existing tags from `git tag`. The date defaults to
// today (UTC).

import { execFileSync } from 'node:child_process';
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const date = process.argv[2] ?? new Date();
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n');
  process.stdout.write(`${nextCalver(date, tags)}\n`);
}
