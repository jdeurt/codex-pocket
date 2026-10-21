import { type PlaywrightTestConfig, devices } from "@playwright/test";

const origin = "http://127.0.0.1:3119";
const config: PlaywrightTestConfig = {
  testDir: "./tests/browser",
  testMatch: "realtime.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: origin, serviceWorkers: "block" },
  projects: [
    {
      name: "realtime-chromium-phone",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
      },
    },
    {
      name: "realtime-chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
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
