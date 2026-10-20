import { BROWSER_ORIGIN } from "./browser-defaults";
import path from "node:path";
import { runNextFixture } from "./next-server";

await runNextFixture("browser", BROWSER_ORIGIN, {
  CODEX_THREAD_ID: "browser-fixture",
  CODEX_CWD: process.cwd(),
  CODEX_BINARY: "/usr/bin/false",
  CODEX_SERVER_ARGS: "[]",
  CODEX_ALLOWED_ORIGINS: BROWSER_ORIGIN,
  CODEX_POCKET_STATE_DIR: path.resolve(".local/browser-fixture/state"),
  CLAUDE_CONFIG_DIR: path.resolve(".local/browser-fixture/claude"),
});
