import { type PlaywrightTestConfig, devices } from "@playwright/test";

const TIMEOUT_MS = 60_000;
const EXPECT_MS = 15_000;
const MEDIA_API = "**/realtime-media-lane.spec.ts";
const config: PlaywrightTestConfig = {
  testDir: "./tests/browser/workflows",
  testMatch: ["voice*.spec.ts", MEDIA_API],
  workers: 1,
  retries: 0,
  timeout: TIMEOUT_MS,
  expect: { timeout: EXPECT_MS },
  use: { baseURL: "http://127.0.0.1:3119", serviceWorkers: "block", trace: "retain-on-failure" },
  projects: [
    { name: "realtime-api", metadata: { fixture: "realtime" }, testMatch: MEDIA_API },
    {
      name: "realtime-chromium",
      metadata: { fixture: "realtime" },
      testIgnore: MEDIA_API,
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
      },
    },
    {
      name: "realtime-webkit",
      metadata: { fixture: "realtime" },
      testIgnore: [MEDIA_API, "**/voice-interruption.spec.ts"],
      use: { ...devices["iPhone 13"], browserName: "webkit", permissions: ["microphone"] },
    },
  ],
};

export default config;
