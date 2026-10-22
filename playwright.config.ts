import {
  AGENT_ORIGIN,
  BROWSER_ORIGIN,
  DESKTOP,
  NARROW_WIDTH,
  PHONE,
  PHONE_HEIGHT,
  POCKETS_ORIGIN,
  SAFARI_HEIGHT,
  SAFARI_WIDTH,
  SPINNER_ORIGIN,
  UPLOAD_ORIGIN,
} from "./tests/fixtures/browser-defaults";
import { type PlaywrightTestConfig, devices } from "@playwright/test";

const TEST_TIMEOUT = 60_000;
const LONG_TEST_TIMEOUT = 180_000;
const EXPECT_TIMEOUT = 15_000;
const SERVER_TIMEOUT = 120_000;
const INTERACTION_TIMEOUT = 45_000;
const REPLAY_TIMEOUT = 90_000;
const LAYOUT_TIMEOUT = 30_000;
const ASSET_EXPECT_TIMEOUT = 20_000;
const NAVIGATION_TIMEOUT = 30_000;
const SHUTDOWN_TIMEOUT = 15_000;
const COPY = "**/browser/copy-action.spec.ts";
const FOCUSED = "**/browser/focused-scroll.spec.ts";
const VIRTUALIZATION = "**/browser/virtualization*.spec.ts";
const RESTART = "**/browser/restart-notice.spec.ts";
const UPLOADS = ["**/uploads/uploads.spec.ts", "**/uploads/gif.spec.ts"];
const ATTACHMENTS = "**/uploads/attachment-layout.spec.ts";
const SPINNER = "**/browser/spinner.spec.ts";
const copyOptions = { testMatch: COPY, timeout: INTERACTION_TIMEOUT };
const focusedOptions = { testMatch: FOCUSED, timeout: INTERACTION_TIMEOUT };
const virtualizationOptions = { testMatch: VIRTUALIZATION, timeout: REPLAY_TIMEOUT };
const assetExpect = { timeout: ASSET_EXPECT_TIMEOUT };
const uploadOptions = { testMatch: UPLOADS, timeout: REPLAY_TIMEOUT, expect: assetExpect };
const attachmentOptions = { testMatch: ATTACHMENTS, timeout: LAYOUT_TIMEOUT, expect: assetExpect };
const spinnerUse = { baseURL: SPINNER_ORIGIN, actionTimeout: EXPECT_TIMEOUT, navigationTimeout: NAVIGATION_TIMEOUT };
const isLiveEnabled = process.env.POCKET_LIVE_TESTS === "1";
const shutdown = { signal: "SIGTERM", timeout: SHUTDOWN_TIMEOUT } as const;
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: TEST_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },
  use: { baseURL: BROWSER_ORIGIN, trace: "retain-on-failure" },
  projects: isLiveEnabled
    ? [
        {
          name: "live",
          testMatch: ["**/browser/live.spec.ts", "**/browser/image-delivery.spec.ts"],
          timeout: LONG_TEST_TIMEOUT,
          expect: { timeout: TEST_TIMEOUT },
          use: { ...PHONE, browserName: "chromium" },
        },
      ]
    : [
        {
          name: "browser-chromium",
          testMatch: [
            "**/browser/image-appearance.spec.ts",
            "**/browser/notifications.spec.ts",
            "**/browser/service-worker.spec.ts",
          ],
          timeout: LONG_TEST_TIMEOUT,
          expect: { timeout: TEST_TIMEOUT },
          use: { ...PHONE, browserName: "chromium" },
        },
        {
          name: "agents",
          testMatch: "**/browser/agent-browser.spec.ts",
          use: { viewport: PHONE.viewport, baseURL: AGENT_ORIGIN, browserName: "chromium" },
        },
        {
          name: "pockets-chromium-phone",
          testMatch: "**/browser/pockets.spec.ts",
          use: { ...PHONE, baseURL: POCKETS_ORIGIN, browserName: "chromium" },
        },
        {
          name: "pockets-webkit-phone",
          testMatch: "**/browser/pockets.spec.ts",
          use: { ...PHONE, baseURL: POCKETS_ORIGIN, browserName: "webkit" },
        },
        { name: "copy-chromium-phone", ...copyOptions, use: { ...PHONE, browserName: "chromium" } },
        { name: "copy-chromium-desktop", ...copyOptions, use: { ...DESKTOP, browserName: "chromium" } },
        { name: "copy-webkit-phone", ...copyOptions, use: { ...PHONE, browserName: "webkit" } },
        { name: "copy-webkit-desktop", ...copyOptions, use: { ...DESKTOP, browserName: "webkit" } },
        {
          name: "focused-chromium-desktop",
          ...focusedOptions,
          use: { ...devices["Desktop Chrome"], serviceWorkers: "block" },
        },
        {
          name: "focused-webkit-desktop",
          ...focusedOptions,
          use: { ...devices["Desktop Safari"], serviceWorkers: "block" },
        },
        {
          name: "focused-chromium-phone",
          ...focusedOptions,
          use: { ...devices["Pixel 7"], serviceWorkers: "block" },
        },
        {
          name: "focused-webkit-phone",
          ...focusedOptions,
          use: { ...devices["iPhone 13"], serviceWorkers: "block" },
        },
        {
          name: "virtualization-chromium-desktop",
          ...virtualizationOptions,
          use: { ...DESKTOP, browserName: "chromium", serviceWorkers: "block" },
        },
        {
          name: "virtualization-chromium-phone",
          ...virtualizationOptions,
          use: { ...PHONE, browserName: "chromium", serviceWorkers: "block" },
        },
        {
          name: "virtualization-webkit-desktop",
          ...virtualizationOptions,
          use: {
            browserName: "webkit",
            viewport: { width: SAFARI_WIDTH, height: SAFARI_HEIGHT },
            serviceWorkers: "block",
          },
        },
        {
          name: "virtualization-webkit-phone",
          ...virtualizationOptions,
          use: { ...PHONE, browserName: "webkit", serviceWorkers: "block" },
        },
        { name: "restart-phone", testMatch: RESTART, use: { ...devices["iPhone 13"], browserName: "chromium" } },
        { name: "restart-desktop", testMatch: RESTART, use: { ...DESKTOP, browserName: "chromium" } },
        {
          name: "uploads-api",
          ...uploadOptions,
          testMatch: "**/uploads/api.spec.ts",
          use: { baseURL: UPLOAD_ORIGIN },
        },
        {
          name: "uploads-chromium-phone",
          ...uploadOptions,
          use: { ...devices["Pixel 7"], baseURL: UPLOAD_ORIGIN, browserName: "chromium" },
        },
        {
          name: "uploads-webkit-phone",
          ...uploadOptions,
          use: { ...devices["iPhone 13"], baseURL: UPLOAD_ORIGIN, browserName: "webkit" },
        },
        {
          name: "uploads-chromium-desktop",
          ...uploadOptions,
          use: { ...DESKTOP, baseURL: UPLOAD_ORIGIN, browserName: "chromium" },
        },
        {
          name: "attachments-chromium-narrow",
          ...attachmentOptions,
          use: {
            ...devices["Pixel 7"],
            baseURL: UPLOAD_ORIGIN,
            viewport: { width: NARROW_WIDTH, height: PHONE_HEIGHT },
            deviceScaleFactor: 1,
            browserName: "chromium",
          },
        },
        {
          name: "attachments-chromium-phone",
          ...attachmentOptions,
          use: {
            ...devices["Pixel 7"],
            ...PHONE,
            baseURL: UPLOAD_ORIGIN,
            deviceScaleFactor: 1,
            browserName: "chromium",
          },
        },
        {
          name: "attachments-webkit-narrow",
          ...attachmentOptions,
          use: {
            ...devices["iPhone 13"],
            baseURL: UPLOAD_ORIGIN,
            viewport: { width: NARROW_WIDTH, height: PHONE_HEIGHT },
            deviceScaleFactor: 1,
            browserName: "webkit",
          },
        },
        {
          name: "attachments-webkit-phone",
          ...attachmentOptions,
          use: {
            ...devices["iPhone 13"],
            ...PHONE,
            baseURL: UPLOAD_ORIGIN,
            deviceScaleFactor: 1,
            browserName: "webkit",
          },
        },
        {
          name: "attachments-chromium-desktop",
          ...attachmentOptions,
          use: { ...DESKTOP, baseURL: UPLOAD_ORIGIN, browserName: "chromium" },
        },
        {
          name: "spinner-chromium",
          testMatch: SPINNER,
          timeout: LONG_TEST_TIMEOUT,
          expect: assetExpect,
          use: { ...spinnerUse, browserName: "chromium" },
        },
        {
          name: "spinner-webkit",
          testMatch: SPINNER,
          timeout: LONG_TEST_TIMEOUT,
          expect: assetExpect,
          use: { ...spinnerUse, browserName: "webkit" },
        },
      ],
  webServer: isLiveEnabled
    ? {
        command: "node --import tsx scripts/live-server.ts",
        url: BROWSER_ORIGIN,
        timeout: LONG_TEST_TIMEOUT,
        reuseExistingServer: false,
        gracefulShutdown: shutdown,
        env: { POCKET_LIVE_TESTS: "1", CODEX_THREAD_ID: "" },
      }
    : [
        {
          name: "pockets-local",
          command: "node --import tsx tests/fixtures/pockets-server.ts",
          url: POCKETS_ORIGIN,
          timeout: SERVER_TIMEOUT,
          reuseExistingServer: false,
          gracefulShutdown: shutdown,
          env: { CODEX_THREAD_ID: "" },
        },
        {
          name: "browser-local",
          command: "node --import tsx tests/fixtures/browser-server.ts",
          url: BROWSER_ORIGIN,
          timeout: SERVER_TIMEOUT,
          reuseExistingServer: false,
          gracefulShutdown: shutdown,
          env: { CODEX_THREAD_ID: "" },
        },
        {
          name: "agent-replay",
          command: "node --import tsx tests/fixtures/agent-browser-server.ts",
          url: AGENT_ORIGIN,
          timeout: SERVER_TIMEOUT,
          reuseExistingServer: false,
          gracefulShutdown: shutdown,
          env: { CODEX_THREAD_ID: "" },
        },
        {
          name: "upload-replay",
          command: "node --import tsx tests/fixtures/uploads-server.ts",
          url: UPLOAD_ORIGIN,
          timeout: SERVER_TIMEOUT,
          reuseExistingServer: false,
          gracefulShutdown: shutdown,
          env: { CODEX_THREAD_ID: "" },
        },
      ],
};

export default config;
