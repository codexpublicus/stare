// The case details on a phone (D214, sheet.js): at 768 px and under, a bar at the foot of
// the case view says what the sidebar holds and opens it as a bottom sheet, at half the
// window's height, then full; a tap, the keyboard, a drag, the scrim, Escape and the Close
// button all work it, the focus goes in and comes back, and the bar never covers the case's
// text. Wider, the sidebar is the sidebar as before.
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
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function openCase(page) {
  await page.goto(CASE);
  await expect(page.locator('#reader .reader-title')).toHaveText(TITLE);
  // The cited cases are counted once they're found.
  await expect(page.locator('#sidebar [role="status"]')).toHaveText(/cited cases? found/);
}

const bar = (page) => page.locator('#sheet-bar');
const sheet = (page) => page.locator('#case-sheet');
const sheetHeight = (page) => sheet(page).evaluate((el) => el.getBoundingClientRect().height);
// Waits for the sheet's slide or resize to finish.
const settled = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));

test.describe('at phone width', () => {
  test.use(PHONE);

  test('the bar says what the sheet holds, and its name is its text', async ({ page }) => {
    await openCase(page);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toHaveAttribute('aria-controls', 'case-sheet');
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
    const cited = Number((await page.locator('#sidebar .citation-status .sidebar-label').textContent()).match(/\((\d+)\)/)[1]);
    expect(cited).toBeGreaterThan(0);
    await expect(bar(page)).toHaveText(new RegExp(`^${cited} cited cases?( · \\d+ other printings?)?$`));
    const text = (await bar(page).textContent()).trim();
    await expect(page.getByRole('button', { name: text, exact: true })).toHaveCount(1);
    // Closed, nothing in the sheet is on screen or in the tab order.
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('#copy-link-btn')).toBeHidden();
  });

  test('a tap opens the sheet at half height, Expand takes it to full, Shrink back, Close shuts it', async ({ page }) => {
    await openCase(page);
    await bar(page).tap();
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet(page)).toHaveAttribute('role', 'dialog');
    await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
    await expect(sheet(page)).toBeFocused();
    await settled(page);
    expect(Math.abs(await sheetHeight(page) - 844 / 2)).toBeLessThan(2);
    await expect(page.locator('#copy-link-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Expand' }).tap();
    await settled(page);
    expect(Math.abs(await sheetHeight(page) - (844 - 40))).toBeLessThan(2);
    await page.getByRole('button', { name: 'Shrink' }).tap();
    await settled(page);
    expect(Math.abs(await sheetHeight(page) - 844 / 2)).toBeLessThan(2);

    await page.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(bar(page)).toBeFocused();
    await expect(sheet(page)).not.toHaveAttribute('role', /./);
    await expect(sheet(page)).toBeHidden();
  });

  test('tapping the scrim closes the sheet', async ({ page }) => {
    await openCase(page);
    await bar(page).tap();
    await settled(page);
    await page.touchscreen.tap(195, 100);
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(sheet(page)).toBeHidden();
  });

  test('by keyboard: Enter opens it, Tab stays inside, Escape closes it and the focus comes back', async ({ page }) => {
    await openCase(page);
    await bar(page).focus();
    await page.keyboard.press('Enter');
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet(page)).toBeFocused();
    // The rest of the case view is inert while the sheet is open.
    expect(await page.evaluate(() => document.querySelector('#resolved .main').inert && document.getElementById('topbar').inert)).toBe(true);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('#case-sheet'));
      expect(inside).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(bar(page)).toBeFocused();
    expect(await page.evaluate(() => document.querySelector('#resolved .main').inert)).toBe(false);
  });

  test('dragging the bar up opens the sheet, and dragging its head down closes it', async ({ page }) => {
    await openCase(page);
    const b = await bar(page).boundingBox();
    const x = b.x + b.width / 2;
    await page.mouse.move(x, b.y + 20);
    await page.mouse.down();
    for (let y = b.y + 20; y >= 300; y -= 40) await page.mouse.move(x, y);
    await page.mouse.up();
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'true');
    await settled(page);
    expect(await sheetHeight(page)).toBeGreaterThan(400);

    const head = await page.locator('#sheet-head').boundingBox();
    await page.mouse.move(head.x + 40, head.y + 10);
    await page.mouse.down();
    for (let y = head.y + 10; y <= 830; y += 40) await page.mouse.move(head.x + 40, y);
    await page.mouse.up();
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(sheet(page)).toBeHidden();
  });

  test('the bar covers none of the case: the text ends above it', async ({ page }) => {
    await openCase(page);
    const content = page.locator('#resolved .main-content');
    await content.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = await page.locator('#reader .reader').evaluate((el) => {
      const kids = el.querySelectorAll('p, div');
      return kids[kids.length - 1].getBoundingClientRect().bottom;
    });
    const top = (await bar(page).boundingBox()).y;
    expect(last).toBeLessThanOrEqual(top);
    const box = await content.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(top + 0.5);
  });

  test('"in text" closes a full-height sheet to show the place, and leaves a half-height one open', async ({ page }) => {
    await openCase(page);
    const show = page.locator('#case-sheet .cited-show').first();
    const current = page.locator('#reader .cite-place-current').first();

    await bar(page).tap();
    await settled(page);
    await show.tap();
    await expect(current).toBeVisible();
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet(page)).toHaveAttribute('data-size', 'half');

    await page.getByRole('button', { name: 'Expand' }).tap();
    await settled(page);
    await show.tap();
    await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(bar(page)).toBeFocused();
    await expect(sheet(page)).toBeHidden();
    await expect(current).toBeInViewport();
    expect(await page.evaluate(() => document.querySelector('#resolved .main').inert)).toBe(false);
  });

  test('reduced motion opens the sheet without a slide', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCase(page);
    await bar(page).tap();
    const motion = await sheet(page).evaluate((el) => Math.max(...getComputedStyle(el).transitionDuration.split(',').map(parseFloat)));
    expect(motion).toBeLessThan(0.01);
  });
});

for (const width of [360, 390, 430]) {
  test(`at ${width} px nothing runs off the side, closed or open`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openCase(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const b = await bar(page).boundingBox();
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(width);
    await bar(page).click();
    await settled(page);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const s = await sheet(page).boundingBox();
    expect(s.x + s.width).toBeLessThanOrEqual(width);
    for (const id of ['#sheet-size', '#sheet-close']) {
      const r = await page.locator(id).boundingBox();
      expect(r.x + r.width, id).toBeLessThanOrEqual(width);
    }
  });
}

test('a phone on its side, too short for two sizes, opens the sheet at its full height', async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 360 });
  await openCase(page);
  await bar(page).click();
  await settled(page);
  expect(Math.abs(await sheetHeight(page) - (360 - 40))).toBeLessThan(2);
  await expect(page.locator('#sheet-size')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('wider than a phone the sidebar is a column, with no bar or sheet head', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openCase(page);
  await expect(bar(page)).toBeHidden();
  await expect(page.locator('#sheet-head')).toBeHidden();
  await expect(page.locator('#sidebar')).toBeVisible();
  const side = await page.locator('#sidebar').boundingBox();
  expect(side.width).toBe(300);
  expect(side.x + side.width).toBe(1366);
});

test('an open sheet closes when the window grows past phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCase(page);
  await bar(page).click();
  await expect(bar(page)).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(bar(page)).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.querySelector('#resolved .main').inert)).toBe(false);
  await expect(page.locator('#sidebar')).toBeVisible();
});
