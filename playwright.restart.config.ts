import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "restart-notice.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://127.0.0.1:3217", trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: "next dev --hostname 127.0.0.1 --port 3217",
    url: "http://127.0.0.1:3217",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "development",
      CODEX_THREAD_ID: "",
      CODEX_POCKET_STATE_DIR: path.resolve(".local", "restart-browser", crypto.randomUUID()),
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
