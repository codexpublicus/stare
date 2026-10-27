// The content blockers' filter lists the site is checked against (#265), and a cache for
// them. The lists are the ones the #258 spike audited: what uBlock Origin and uBlock
// Origin Lite turn on by default (EasyList, EasyPrivacy, Peter Lowe's, uBO's own), plus
// AdGuard's base and tracking lists and Fanboy's annoyances, which other blockers ship.
//
// They are fetched when the check runs, not vendored: they change daily, together they're
// about 25 MB, and a rule added tomorrow is the one the check is for. Each is kept in
// `cacheDir` and fetched again once it is a day old; if every URL for a list fails, a
// copy up to two weeks old is used with a warning, and with none the check fails. CI keeps
// the cache between runs (.github/actions/build-site), so a list host being down doesn't
// fail a build.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UBO = (name) => [
  `https://ublockorigin.github.io/uAssetsCDN/filters/${name}.min.txt`,
  `https://ublockorigin.pages.dev/filters/${name}.min.txt`,
  `https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/filters/${name}.min.txt`,
];

/** Each list: its name (the cache file) and its URLs, tried in order. */
export const FILTER_LISTS = [
  { name: 'easylist', urls: ['https://easylist.to/easylist/easylist.txt', 'https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt'] },
  { name: 'easyprivacy', urls: ['https://easylist.to/easylist/easyprivacy.txt', 'https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt'] },
  { name: 'ubo-filters', urls: UBO('filters') },
  { name: 'ubo-privacy', urls: UBO('privacy') },
  { name: 'ubo-badware', urls: UBO('badware') },
  { name: 'ubo-quick-fixes', urls: UBO('quick-fixes') },
  { name: 'ubo-unbreak', urls: UBO('unbreak') },
  { name: 'peter-lowe', urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext'] },
  { name: 'adguard-base', urls: ['https://filters.adtidy.org/extension/ublock/filters/2.txt'] },
  { name: 'adguard-tracking', urls: ['https://filters.adtidy.org/extension/ublock/filters/3.txt'] },
  { name: 'fanboy-annoyance', urls: ['https://easylist.to/easylist/fanboy-annoyance.txt', 'https://secure.fanboy.co.nz/fanboy-annoyance.txt'] },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = DAY_MS;
const STALE_MS = 14 * DAY_MS;

/** Where the lists are kept: $STARE_FILTERLIST_CACHE, else ~/.cache/stare/filterlists. */
export function defaultCacheDir(env = process.env) {
  if (env.STARE_FILTERLIST_CACHE) return env.STARE_FILTERLIST_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stare', 'filterlists');
}

/**
 * Whether `text` is a filter list rather than an error page: more than 100 lines, none
 * of the first few HTML.
 */
export function looksLikeFilterList(text) {
  const lines = text.split('\n');
  if (lines.length < 100) return false;
  return !lines.slice(0, 5).some((l) => /^\s*<(!doctype|html|head|link|meta)\b/i.test(l));
}

/**
 * `text` with each `!#include <file>` line replaced by that file, fetched relative to
 * `base` (uBO's lists split themselves this way; only same-directory includes are
 * followed, as uBO does).
 */
export async function expandIncludes(text, base, fetchText) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^!#include\s+(\S+)\s*$/.exec(line);
    if (!m || m[1].includes('/') || m[1].includes('..')) {
      out.push(line);
      continue;
    }
    out.push(await fetchText(new URL(m[1], base).href));
  }
  return out.join('\n');
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'stare.pub filter-list check (+https://github.com/codexpublicus/stare)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Every list's text, from the cache when under a day old, else fetched (and cached).
 * Returns `[{ name, text, source, age }]`; `warn` hears of a stale copy used.
 */
export async function loadFilterLists({ cacheDir = defaultCacheDir(), lists = FILTER_LISTS, now = Date.now(), fetcher = fetchText, warn = console.warn } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  return Promise.all(lists.map(async ({ name, urls }) => {
    const file = join(cacheDir, `${name}.txt`);
    const age = existsSync(file) ? now - statSync(file).mtimeMs : Infinity;
    if (age < FRESH_MS) return { name, text: readFileSync(file, 'utf8'), source: file, age };
    const errors = [];
    for (const url of urls) {
      try {
        const text = await expandIncludes(await fetcher(url), url, fetcher);
        if (!looksLikeFilterList(text)) throw new Error(`${url}: not a filter list`);
        writeFileSync(file, text);
        return { name, text, source: url, age: 0 };
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (age < STALE_MS) {
      warn(`${name}: using the cached copy from ${Math.round(age / 3_600_000)} hours ago; ${errors.join('; ')}`);
      return { name, text: readFileSync(file, 'utf8'), source: file, age };
    }
    throw new Error(`${name}: couldn't fetch it and have no copy under two weeks old: ${errors.join('; ')}`);
  }));
}
