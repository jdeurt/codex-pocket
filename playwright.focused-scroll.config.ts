import { defineConfig, devices } from "@playwright/test";

// This flow uses browser-local snapshots. Never start the real Codex test bridge.
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "focused-scroll.spec.ts",
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:3114",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
    { name: "chromium-phone", use: { ...devices["Pixel 7"] } },
    { name: "webkit-phone", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 3114",
    env: {
      NODE_ENV: "development",
      CODEX_THREAD_ID: "",
      CODEX_BINARY: "/usr/bin/false",
      CODEX_POCKET_STATE_DIR: ".local/focused-scroll/state",
    },
    url: "http://127.0.0.1:3114",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
