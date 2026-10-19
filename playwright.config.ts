import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testIgnore: ["**/agent-browser.spec.ts", "**/virtualization*.spec.ts"],
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run test:server",
    url: "http://127.0.0.1:3101",
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
