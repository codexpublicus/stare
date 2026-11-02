/**
 * Key folding, ordering and shard routing.
 *
 * These match the Python writer's rules in src/roaringbuckets/core/keys.py exactly; see
 * "Key folding and shard prefixes" in docs/FORMAT_V3.md.
 *
 * - Folding is ASCII-only: A-Z become a-z and every other character is unchanged. JS
 *   `toLowerCase()` and Python `str.lower()` both apply Unicode rules that vary by runtime
 *   and can change a string's length (`İ` lowercases to two code points).
 * - Keys sort by code point (the writer's order, and UTF-8 byte order). JS `<` compares
 *   UTF-16 code units, which puts characters above U+FFFF before U+E000-U+FFFF.
 * - A shard prefix is the first `shard_depth` code points of the folded key, not UTF-16
 *   code units, so an emoji counts as one character.
 */

const UPPER_ASCII = /[A-Z]/g;

/**
 * Fold a key for case-insensitive comparison and shard routing.
 *
 * @param {string} key - Index key
 * @returns {string} The key with ASCII A-Z lowercased and nothing else changed
 */
export function foldKey(key) {
  return key.replace(UPPER_ASCII, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Rank a UTF-16 code unit so that comparing ranks orders strings by code point: surrogates
 * (U+D800-U+DFFF, which encode U+10000 and up) move above U+E000-U+FFFF.
 *
 * @param {number} unit - UTF-16 code unit
 * @returns {number}
 */
function codePointRank(unit) {
  if (unit >= 0xe000) return unit - 0x800;
  if (unit >= 0xd800) return unit + 0x2000;
  return unit;
}

/**
 * Compare two strings by code point, the order the Python writer sorts keys in.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero or positive, like a sort comparator
 */
export function compareKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}

/**
 * Count a string's code points.
 *
 * @param {string} key
 * @returns {number}
 */
export function codePointLength(key) {
  let n = 0;
  for (const _ of key) n++;
  return n;
}

/**
 * Get the shard a key belongs to in a prefix-sharded index.
 *
 * @param {string} key - Index key
 * @param {number} depth - The dimension's `shard_depth`, in code points
 * @returns {string} The first `depth` code points of the folded key
 */
export function shardPrefix(key, depth) {
  let end = 0;
  let count = 0;
  for (const ch of key) {
    if (count === depth) break;
    end += ch.length;
    count++;
  }
  return foldKey(key.slice(0, end));
}
