import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { runNextFixture } from "./next-server";

const origin = "http://127.0.0.1:3119";
const directory = path.resolve(".local/realtime-fixture");

await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await runNextFixture("realtime", origin, {
  CODEX_THREAD_ID: "realtime-fixture-parent",
  CODEX_CWD: process.cwd(),
  CODEX_BINARY: process.execPath,
  CODEX_SERVER_ARGS: JSON.stringify(["--import", "tsx", "tests/fixtures/realtime-rpc.ts"]),
  CODEX_ALLOWED_ORIGINS: origin,
  CODEX_POCKET_STATE_DIR: path.join(directory, "state"),
  CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
});
