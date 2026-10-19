import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "spinner.spec.ts",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    baseURL: "http://127.0.0.1:3103",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
