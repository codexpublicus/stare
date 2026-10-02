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
  // in CI without hiding a deterministic failure.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
