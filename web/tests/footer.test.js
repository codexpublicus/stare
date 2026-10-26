// The Codex Publicus footer (#257, codexpublicus.org#8): SiteFooter.astro carries the
// vendored canonical fragment with stare.pub's slots filled, and nothing else may differ.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = readFileSync(join(WEB, 'src/vendor/cp-footer/footer.html'), 'utf8');
const component = readFileSync(join(WEB, 'src/components/SiteFooter.astro'), 'utf8');

// The fragment from its opening comment to its closing one, each slot's content dropped.
function fragment(text) {
  const start = text.indexOf('<!-- cp-footer:');
  const end = text.indexOf('<!-- /cp-footer -->');
  assert.ok(start >= 0 && end > start, 'cp-footer comments not found');
  return text
    .slice(start, end + '<!-- /cp-footer -->'.length)
    .replace(/(<!-- slot:([\w-]+) -->)[\s\S]*?(<!-- \/slot:\2 -->)/g, '$1$3');
}

describe('the footer', () => {
  test('matches the canonical fragment outside its slots', () => {
    assert.equal(fragment(component), fragment(canonical));
  });

  test('the GitHub, X and Hugging Face links are rel="me", labelled, in the same window', () => {
    const f = fragment(component);
    for (const [href, label] of [
      ['https://github.com/codexpublicus', 'GitHub'],
      ['https://x.com/codexpublicus', 'X'],
      ['https://huggingface.co/codexpublicus', 'Hugging Face'],
    ]) {
      const re = new RegExp(`<a class="cp-footer-icon" href="${href}" rel="me" aria-label="${label}" title="${label}"><svg [^>]*aria-hidden="true"`);
      assert.match(f, re, `${label} link`);
    }
    assert.doesNotMatch(component, /target="_blank"/);
  });

  test("stare.pub's line has the data terms, the index and the build", () => {
    const line = component.match(/<!-- slot:site-line -->([\s\S]*?)<!-- \/slot:site-line -->/)[1];
    assert.match(line, /<a href="\/data#licences">Data terms<\/a>/);
    assert.match(line, /data-site-data-line/);
    assert.match(line, /info\.href/);
  });
});
