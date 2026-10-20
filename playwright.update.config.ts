import { type PlaywrightTestConfig, devices } from "@playwright/test";

const TEST_TIMEOUT_MS = 120_000;
const EXPECT_TIMEOUT_MS = 30_000;

const config: PlaywrightTestConfig = {
  testDir: "./tests/updates",
  globalSetup: "./tests/fixtures/update-builds.ts",
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  workers: 1,
  fullyParallel: false,
  projects: [
    { name: "update-chromium", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "update-webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
  use: { baseURL: "http://127.0.0.1:3191", trace: "retain-on-failure" },
};

export default config;
