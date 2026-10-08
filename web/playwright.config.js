// Smoke tests against a deployed stare.pub: a workers.dev preview in CI
// (site.yml), or any URL locally (`mise run e2e <url>`). Nothing here starts
// a server; STARE_BASE_URL must point at a running site.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.STARE_BASE_URL;
if (!baseURL) {
  throw new Error('Set STARE_BASE_URL to the site to test, e.g. https://main-stare-pub.nick-441.workers.dev');
}

export default defineConfig({
  testDir: './e2e',
  // The previews are public and shared; one retry absorbs a network blip
  // in CI without hiding a deterministic failure. The main preview's run
  // passes --retries=0 (site.yml), so flakiness shows up there.
  retries: process.env.CI ? 1 : 0,
  // Opening a case is a chain of fetches (the WASM and citare's bundle, the
  // manifest, one or two .bins, the .multi, the case zip) before anything
  // renders, and the cited-cases pass fetches a .bin per citation. With the
  // suite at --repeat-each=20 and 16 workers, that took 6 to 9 s in the
  // failures behind #133, past the 5 s default.
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
