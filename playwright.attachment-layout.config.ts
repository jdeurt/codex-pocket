import { defineConfig, devices } from "@playwright/test";
import uploads from "./playwright.uploads.config";

function mobile(browserName: "chromium" | "webkit", width: number) {
  return {
    name: `${browserName}-${String(width)}`,
    use: {
      ...devices[browserName === "webkit" ? "iPhone 13" : "Pixel 7"],
      browserName,
      viewport: { width, height: 844 },
      deviceScaleFactor: 1,
    },
  };
}

const uploadServer = uploads.webServer;

if (!uploadServer || Array.isArray(uploadServer)) {
  throw new Error("The upload fixture requires one isolated web server.");
}

const NARROW_WIDTH = 320;
const MOBILE_WIDTH = 390;

export default defineConfig({
  ...uploads,
  testMatch: "attachment-layout.spec.ts",
  timeout: 30_000,
  projects: [
    mobile("chromium", NARROW_WIDTH),
    mobile("chromium", MOBILE_WIDTH),
    mobile("webkit", NARROW_WIDTH),
    mobile("webkit", MOBILE_WIDTH),
    { name: "desktop-1280", use: { browserName: "chromium", viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    ...uploadServer,
    command: "CODEX_THREAD_ID='' NODE_ENV=development node --import tsx scripts/uploads-replay.ts",
  },
});
