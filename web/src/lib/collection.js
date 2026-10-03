// The collection's size, from one data file (web/src/data/collection.json).
// Every page, social description and the OG image take their figures from
// here; web/tests/collection.test.js fails on a figure typed anywhere else.
import collection from '../data/collection.json' with { type: 'json' };

export { collection };

// 6,920,596 -> "6.9 million". One decimal, rounded down, so the site never
// claims more cases than it has.
export function formatMillions(n) {
  if (!Number.isInteger(n) || n < 1_000_000) {
    throw new RangeError(`formatMillions expects an integer of at least a million, got ${n}`);
  }
  const tenths = Math.floor(n / 100_000);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return frac === 0 ? `${whole} million` : `${whole}.${frac} million`;
}

// 40622 -> "40,622"
export function formatCount(n) {
  return n.toLocaleString('en-US');
}

// formatMillions(cases) + " cases"
export const casesLabel = `${formatMillions(collection.cases)} cases`;

// "1658–2020"
export const yearRange = `${collection.first_year}–${collection.last_year}`;
