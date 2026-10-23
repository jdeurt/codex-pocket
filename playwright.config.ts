import { type PlaywrightTestConfig, devices } from "@playwright/test";
import { AGENT_ORIGIN, POCKETS_ORIGIN, UPLOAD_ORIGIN, BROWSER_ORIGIN } from "./tests/fixtures/browser-defaults";

const TIMEOUT_MS = 90_000;
const EXPECT_MS = 15_000;
const LIVE_MS = 180_000;
const SHUTDOWN_MS = 15_000;
const isLive = process.env.POCKET_LIVE_TESTS === "1";
const workflows = "**/browser/workflows/";
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  workers: 1,
  retries: 0,
  timeout: TIMEOUT_MS,
  expect: { timeout: EXPECT_MS },
  use: { trace: "retain-on-failure" },
  projects: isLive
    ? [
        {
          name: "live",
          testMatch: ["**/browser/live.spec.ts", "**/browser/image-delivery.spec.ts"],
          timeout: LIVE_MS,
          use: { ...devices["Pixel 7"], baseURL: BROWSER_ORIGIN, browserName: "chromium" },
        },
      ]
    : [
        ...[
          {
            fixture: "pockets",
            origin: POCKETS_ORIGIN,
            match: [`${workflows}conversation.spec.ts`, `${workflows}transcript.spec.ts`],
          },
          { fixture: "agents", origin: AGENT_ORIGIN, match: [`${workflows}side-pockets.spec.ts`] },
          {
            fixture: "uploads",
            origin: UPLOAD_ORIGIN,
            match: ["**/uploads/uploads.spec.ts", "**/uploads/gif.spec.ts"],
          },
        ].flatMap(({ fixture, origin, match }) => [
          {
            name: `${fixture}-chromium`,
            metadata: { fixture },
            testMatch: match,
            use: { ...devices["Desktop Chrome"], browserName: "chromium" as const, baseURL: origin },
          },
          {
            name: `${fixture}-webkit`,
            metadata: { fixture },
            testMatch: match,
            use: { ...devices["iPhone 13"], browserName: "webkit" as const, baseURL: origin },
          },
        ]),
        {
          name: "uploads-api",
          metadata: { fixture: "uploads" },
          testMatch: "**/uploads/api.spec.ts",
          use: { baseURL: UPLOAD_ORIGIN },
        },
      ],
  ...(isLive && {
    webServer: {
      command: "node --import tsx scripts/live-server.ts",
      url: BROWSER_ORIGIN,
      timeout: LIVE_MS,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: SHUTDOWN_MS },
      env: { POCKET_LIVE_TESTS: "1", CODEX_THREAD_ID: "" },
    },
  }),
};

export default config;
