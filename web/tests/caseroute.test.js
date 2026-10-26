import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isCaseHash } from '../src/lib/caseroute.js';
import { parseHash } from '../public/js/router.js';

// Every form router.js documents, and the ones the site links to.
const CASES = [
  '#a2d/31/647',
  '#a2d/31/647-01',
  '#a2d/31/647-02',
  '#a3d/138-2/1012',
  '#a3d/138-2/1012-01',
  '#p2d/997/1021-01@1023',
  '#a2d/31/647-01~c=3',
  '#p2d/997/1021-01@1023~c=12',
  '#cai-cas/1/xxix-01',
  '#cal-app-4th/15/supp.%201-01',
  '#us/598/175-01',
  '#f4th/1/1-01',
  '#A2D/31/647-01',
  '#a2d/0031/0647-01',
  'a2d/31/647-01',
  '#a2d 31 647',
];

// The landing's: no hash, an empty one, anchors and anything else parseHash refuses.
const NOT_CASES = [
  '',
  '#',
  '#top',
  '#about',
  '#a2d',
  '#a2d/31',
  '#a2d/31/',
  '#a2d/x31/647-01',
  '#a2d/31-/647-01',
  '#a2d/31/647a-01',
  '#a2d/31/647%2C648',
  '#a2d/31/%E0%A4%A',
  '#a2d/31/647-01~c=0',
  '#a2d/31/647@',
  '#a2d/31/%23x',
  '#a2d/31/%01x',
  '#a2d/31/%20',
  '#a2d%2031%20647',
  `#a2d/31/${'9'.repeat(20)}`,
];

describe('isCaseHash', () => {
  for (const hash of CASES) {
    test(`${JSON.stringify(hash)} is a case`, () => {
      assert.ok(parseHash(hash), 'parseHash accepts it');
      assert.equal(isCaseHash(hash), true);
    });
  }
  for (const hash of NOT_CASES) {
    test(`${JSON.stringify(hash)} is the landing`, () => {
      assert.equal(parseHash(hash), null, 'parseHash refuses it');
      assert.equal(isCaseHash(hash), false);
    });
  }
  test('null and undefined are the landing', () => {
    assert.equal(isCaseHash(null), false);
    assert.equal(isCaseHash(undefined), false);
  });

  // Hashes built from the characters that matter to either parser, so a change
  // to router.js's rules that isCaseHash doesn't follow fails here.
  test('agrees with router.js parseHash on generated hashes', () => {
    const reporters = ['a2d', 'cai-cas', 'A2D', '', 'a2d x', '%20'];
    const seps = ['/', ' ', '//', '', '%20', '/ '];
    const volumes = ['31', '138-2', '0031', '31-', 'x31', '3a', '', '1b-c'];
    const parts = ['647', '0', 'xxix', 'supp.%201', 'Supp.  1', '-01', '-1', '@1023', '@', '~c=3',
      '~c=0', '~', '%2C', '%23', '%', '%01', '9'.repeat(17), ' ', '-', '/', 'a', '647a'];
    let seed = 1;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = (list) => list[rand(list.length)];
    let cases = 0;
    for (let i = 0; i < 20000; i++) {
      let hash = `#${pick(reporters)}${pick(seps)}${pick(volumes)}${pick(seps)}`;
      const len = 1 + rand(4);
      for (let j = 0; j < len; j++) hash += pick(parts);
      const expected = parseHash(hash) !== null;
      if (expected) cases++;
      assert.equal(isCaseHash(hash), expected, hash);
    }
    // Enough of both kinds for the comparison to mean something.
    assert.ok(cases > 2000 && cases < 18000, `${cases} of 20000 were cases`);
  });
});
