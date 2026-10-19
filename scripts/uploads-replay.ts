// No real Codex process, session, or credentials are used by this server.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveUpload } from "../src/server/uploads";
import { spawn } from "node:child_process";

const directory = path.resolve(".local/uploads-replay");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "state");
const unrelatedId = crypto.randomUUID();
await saveUpload(
  "unrelated-parent",
  unrelatedId,
  new Request(`http://fixture/api/uploads?name=private.txt&type=text%2Fplain`, {
    method: "PUT",
    body: "PRIVATE_OTHER_PARENT",
  })
);
await writeFile(path.join(directory, "unrelated-id.txt"), unrelatedId);
const host = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3118"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      CODEX_THREAD_ID: "upload-replay-parent",
      CODEX_CWD: process.cwd(),
      CODEX_BINARY: process.execPath,
      CODEX_SERVER_ARGS: JSON.stringify([path.resolve("tests/fixtures/uploads-rpc.mjs")]),
      CODEX_POCKET_STATE_DIR: path.join(directory, "state"),
      CODEX_ALLOWED_ORIGINS: "http://127.0.0.1:3118",
      CODEX_ACTIVE_MESSAGE_MODE: "queue",
      POCKET_UPLOAD_REPLAY: directory,
    },
  }
);
process.once("SIGTERM", () => host.kill("SIGTERM"));
process.once("SIGINT", () => host.kill("SIGINT"));
await new Promise((resolve) => host.once("exit", resolve));
