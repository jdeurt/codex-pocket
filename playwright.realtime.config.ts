import { type PlaywrightTestConfig, devices } from "@playwright/test";

const origin = "http://127.0.0.1:3119";
const MEDIA_API = "**/realtime-media-lane.spec.ts";
const config: PlaywrightTestConfig = {
  testDir: "./tests/browser",
  testMatch: "realtime*.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: origin, serviceWorkers: "block", trace: "retain-on-failure" },
  projects: [
    { name: "realtime-api", testMatch: MEDIA_API },
    {
      name: "realtime-chromium-phone",
      testIgnore: MEDIA_API,
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
      },
    },
    {
      name: "realtime-chromium-desktop",
      // Recovery runs once per engine; desktop also exercises the UI and gesture flows.
      testIgnore: ["**/realtime-recovery.spec.ts", MEDIA_API],
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
      },
    },
    {
      name: "realtime-webkit-phone",
      testIgnore: MEDIA_API,
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
        permissions: ["microphone"],
      },
    },
  ],
  webServer: {
    command: "node --import tsx tests/fixtures/realtime-server.ts",
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
};

export default config;
