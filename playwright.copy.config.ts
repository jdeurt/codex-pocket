import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "copy-action.spec.ts",
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://127.0.0.1:3117", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium-phone",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    { name: "chromium-desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 900 } } },
    {
      name: "webkit-phone",
      use: { browserName: "webkit", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    { name: "webkit-desktop", use: { browserName: "webkit", viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: "npm run dev -- --port 3117",
    url: "http://127.0.0.1:3117",
    env: {
      NODE_ENV: "development",
      CODEX_THREAD_ID: "",
      CODEX_BINARY: "/usr/bin/false",
      CODEX_POCKET_STATE_DIR: path.resolve(".local/copy-action-browser-state"),
    },
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
