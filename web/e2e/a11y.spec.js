// The reader by keyboard and screen reader (#270): the view tabs are ARIA tabs, the top
// bar's citation and the sidebar's actions are buttons, a case opened from a search takes the
// focus to its title, the status lines are live regions, citation previews show on focus,
// the phone's case details sheet keeps the focus while open, every control has a visible focus ring in
// both themes, and reduced motion stills every animation.
import { test as base, expect } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') problems.push(`console.${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
    await use(page);
    expect(problems, 'console errors or warnings').toEqual([]);
  },
});

const CASE = '/#a2d/142/148-01';
const TITLE = 'Renaire Corp. v. Vaughn';

async function openCase(page) {
  await page.goto(CASE);
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  await expect(page.locator('#tab-pages')).toBeVisible();
}

// The element with the focus, as `tag#id` or `tag.class`.
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}` : null;
});

test('the view tabs are a tablist the arrow keys move through, and Enter opens one', async ({ page }) => {
  await openCase(page);
  const tablist = page.getByRole('tablist', { name: 'Case views' });
  await expect(tablist.getByRole('tab')).toHaveText(['Reader', 'Archival PDF', 'Raw Scans']);
  const reader = page.getByRole('tab', { name: 'Reader' });
  await expect(reader).toHaveAttribute('aria-selected', 'true');
  await expect(reader).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('tab', { name: 'Raw Scans' })).toHaveAttribute('tabindex', '-1');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'reader');

  await reader.focus();
  await page.keyboard.press('ArrowRight');
  expect(await focused(page)).toBe('button#tab-pdf');
  await page.keyboard.press('End');
  expect(await focused(page)).toBe('button#tab-pages');
  await page.keyboard.press('ArrowRight');
  expect(await focused(page)).toBe('button#tab-reader');
  await page.keyboard.press('ArrowLeft');
  expect(await focused(page)).toBe('button#tab-pages');
  // Moving the focus opens nothing; Enter does.
  await expect(reader).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const scans = page.getByRole('tab', { name: 'Raw Scans' });
  await expect(scans).toHaveAttribute('aria-selected', 'true');
  await expect(scans).toHaveAttribute('tabindex', '0');
  await expect(reader).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#page-viewer')).toBeVisible();
  await expect(page.locator('#reader')).toBeHidden();
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await expect(reader).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#reader')).toBeVisible();
});

test('a citation searched from the landing opens with the focus on the case\'s title', async ({ page }) => {
  await page.goto('/');
  await page.locator('#landing-input').fill('a2d 142 148');
  await page.keyboard.press('Enter');
  await expect(page.locator('#topbar-case')).toHaveText(TITLE);
  const title = page.getByRole('heading', { level: 1, name: TITLE });
  await expect(title).toBeFocused();
  // Drawn again once the citations are found, it keeps it.
  await expect(page.locator('#reader a.cite-link').first()).toBeVisible();
  await expect(title).toBeFocused();
  await expect(page.getByRole('main')).toBeVisible();
});

test('the top bar\'s citation is a button: Enter edits it, Escape puts the focus back', async ({ page }) => {
  await openCase(page);
  const cite = page.getByRole('button', { name: 'Search another citation' });
  await cite.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#topbar-cite-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cite).toBeFocused();
});

test('the skip link goes to the case\'s title and leaves the address alone', async ({ page }) => {
  await openCase(page);
  const hash = await page.evaluate(() => location.hash);
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to the case' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeFocused();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
});

test('the status lines are live regions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#landing-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('#status-bar')).toHaveAttribute('role', 'status');
});

test('Copy permalink and View as JSON are buttons, and Copy says it copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCase(page);
  await expect(page.getByRole('button', { name: 'Copy permalink' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View as JSON' })).toBeVisible();
  // By id: once it says Copied, its name isn't "Copy permalink".
  const copy = page.locator('#copy-link-btn');
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(copy).toHaveText(/Copied/);
  await expect(page.locator('#copy-status')).toHaveText('Permalink copied to the clipboard');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.evaluate(() => location.href));
});

test('a citation\'s preview shows on keyboard focus, described by it, and Escape hides it', async ({ page }) => {
  await openCase(page);
  const link = page.locator('#reader a.cite-link[href^="#va/164/"]').first();
  await expect(link).toBeVisible();
  // A key pressed first, so the focus that follows counts as the keyboard's (:focus-visible).
  await page.keyboard.press('Shift');
  await link.focus();
  await expect(link).toBeFocused();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('Universal Credit Co. v. Taylor');
  const id = await tip.getAttribute('id');
  await expect(link).toHaveAttribute('aria-describedby', id);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  await expect(link).not.toHaveAttribute('aria-describedby', /./);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the case details bar says whether the sheet is open, and the sheet keeps the focus until Escape', async ({ page }) => {
    await openCase(page);
    // Its name is its visible text (sheet.js): the counts, or "Case details" before them.
    const toggle = page.locator('#sheet-bar');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('dialog', { name: 'Case details' })).toBeFocused();
    // Tab goes round the sheet's controls, never into the reader behind.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => document.activeElement?.closest('#case-sheet') !== null);
      expect(inside).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.locator('#case-sheet')).toBeHidden();
  });
});

for (const theme of ['light', 'dark']) {
  test(`every control the keyboard reaches has a visible focus ring (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await openCase(page);
    await page.locator('body').focus();
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const cs = getComputedStyle(a);
        return {
          what: `${a.tagName.toLowerCase()}#${a.id || a.className}`,
          visible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
        };
      });
      if (!ring) continue;
      seen.add(ring.what);
      expect(ring.visible, ring.what).toBe(true);
    }
    // Then the sidebar's, after the case's text in the tab order.
    await page.keyboard.press('Shift');
    await page.locator('#sidebar').locator('a[href], button').first().focus();
    for (let i = 0; i < 8; i++) {
      const ring = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body || !a.closest('#sidebar')) return null;
        const cs = getComputedStyle(a);
        return { what: `${a.tagName.toLowerCase()}#${a.id || a.className}`, visible: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
      });
      if (ring) {
        seen.add(ring.what);
        expect(ring.visible, ring.what).toBe(true);
      }
      await page.keyboard.press('Tab');
    }
    // The top bar, the tabs and the sidebar are all in the walk.
    const all = [...seen].join(' ');
    expect(all).toContain('button#topbar-cite');
    expect(all).toContain('button#tab-reader');
    expect(all).toContain('button#copy-link-btn');
  });
}

test('reduced motion stills the spinner and the transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openCase(page);
  const motion = await page.evaluate(() => {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    document.body.appendChild(spinner);
    const s = getComputedStyle(spinner);
    const tab = getComputedStyle(document.getElementById('tab-reader'));
    const out = { spin: parseFloat(s.animationDuration), tab: parseFloat(tab.transitionDuration) };
    spinner.remove();
    return out;
  });
  expect(motion.spin).toBeLessThan(0.01);
  expect(motion.tab).toBeLessThan(0.01);
});
