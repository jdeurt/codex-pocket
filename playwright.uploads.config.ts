import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/uploads",
  testMatch: "uploads.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: "http://127.0.0.1:3118", trace: "retain-on-failure" },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
    { name: "desktop-chromium", use: { browserName: "chromium", viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: "node --import tsx scripts/uploads-replay.ts",
    url: "http://127.0.0.1:3118",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
