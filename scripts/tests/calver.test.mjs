import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calverDay, nextCalver } from '../calver.mjs';

const DAY = new Date('2026-09-30T15:04:05Z');

describe('calverDay', () => {
  test('formats the UTC date with zero padding', () => {
    assert.equal(calverDay(new Date('2026-01-02T00:00:00Z')), '2026.01.02');
  });

  test('uses UTC, not the local clock', () => {
    // 23:30 at UTC-5 on the 1st is already the 2nd in UTC.
    assert.equal(calverDay(new Date('2026-03-01T23:30:00-05:00')), '2026.03.02');
  });

  test('accepts a YYYY-MM-DD string', () => {
    assert.equal(calverDay('2026-09-30'), '2026.09.30');
  });

  test('rejects an invalid date', () => {
    assert.throws(() => calverDay('not a date'), /invalid date/);
  });
});

describe('nextCalver', () => {
  test('first release of the day is .1', () => {
    assert.equal(nextCalver(DAY, []), 'v2026.09.30.1');
  });

  test('ignores tags from other days and other formats', () => {
    const tags = ['v2026.09.29.1', 'v2026.09.29.2', 'v1.2.3', 'dags/2026.09.30.4', 'v2026.09.30.1-rc'];
    assert.equal(nextCalver(DAY, tags), 'v2026.09.30.1');
  });

  test('Nth release of the day counts the day\'s existing tags', () => {
    const tags = ['v2026.09.30.1', 'v2026.09.30.2', 'v2026.09.29.7'];
    assert.equal(nextCalver(DAY, tags), 'v2026.09.30.3');
  });

  test('a gap in the day\'s tags does not reuse an existing tag', () => {
    // Counting would give 2 + 1 = .3, which already exists.
    const tags = ['v2026.09.30.1', 'v2026.09.30.3'];
    assert.equal(nextCalver(DAY, tags), 'v2026.09.30.4');
  });

  test('orders by number, not by string', () => {
    const tags = ['v2026.09.30.9', 'v2026.09.30.10', 'v2026.09.30.2'];
    assert.equal(nextCalver(DAY, tags), 'v2026.09.30.11');
  });

  test('tolerates whitespace and blank lines from `git tag` output', () => {
    assert.equal(nextCalver(DAY, [' v2026.09.30.1 ', '', '\n']), 'v2026.09.30.2');
  });
});
