import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Content blockers' filter lists (EasyPrivacy and the like) block scripts by name, and one
// blocked module takes the whole reader down with it: v2026.10.26.5 shipped js/pageview.js,
// which uBlock Origin refused. Names that read like analytics or ads stay out of the site.
const BLOCKED = /pageview|analytic|track|beacon|pixel|telemetry|metric|stats|collect|advert|(^|[-_.])ads?([-_.]|$)|banner|sponsor|affiliate|tagmanager|gtag/i;

const dir = fileURLToPath(new URL('../public/js/', import.meta.url));

test('no site script has a name content blockers block', () => {
  const bad = readdirSync(dir).filter((name) => BLOCKED.test(name));
  assert.deepEqual(bad, []);
});
