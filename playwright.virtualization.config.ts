import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "virtualization*.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://127.0.0.1:3113", trace: "retain-on-failure", serviceWorkers: "block" },
  projects: [
    { name: "chromium-desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 900 } } },
    {
      name: "chromium-mobile",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    { name: "webkit-desktop", use: { browserName: "webkit", viewport: { width: 1024, height: 768 } } },
    {
      name: "webkit-mobile",
      use: { browserName: "webkit", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: "env CODEX_THREAD_ID='' NODE_ENV=development npm exec next dev -- --hostname 127.0.0.1 --port 3113",
    url: "http://127.0.0.1:3113",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
