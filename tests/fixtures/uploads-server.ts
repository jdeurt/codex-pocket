// No real Codex process, session, or credentials are used by this server.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { UPLOAD_ORIGIN } from "./browser-defaults";
import path from "node:path";
import { runNextFixture } from "./next-server";
import { saveUpload } from "../../src/server/uploads";

/**
Reset synthetic upload state and save an unrelated parent's file for scope assertions.
@returns The private replay directory shared with the fake upload protocol.
*/
async function prepareUploads() {
  const directory = path.resolve(".local/uploads-replay");
  const unrelatedId = crypto.randomUUID();

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  process.env.CODEX_POCKET_STATE_DIR = path.join(directory, "state");
  await saveUpload(
    "unrelated-parent",
    unrelatedId,
    new Request("http://fixture/api/uploads?name=private.txt&type=text%2Fplain", {
      method: "PUT",
      body: "PRIVATE_OTHER_PARENT",
    })
  );
  await writeFile(path.join(directory, "unrelated-id.txt"), unrelatedId);

  return directory;
}

const directory = await prepareUploads();

await runNextFixture("uploads", UPLOAD_ORIGIN, {
  CODEX_THREAD_ID: "upload-replay-parent",
  CODEX_CWD: process.cwd(),
  CODEX_BINARY: process.execPath,
  CODEX_SERVER_ARGS: JSON.stringify(["--import", "tsx", path.resolve("tests/fixtures/uploads-rpc.ts")]),
  CODEX_POCKET_STATE_DIR: path.join(directory, "state"),
  CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
  CODEX_ALLOWED_ORIGINS: UPLOAD_ORIGIN,
  CODEX_ACTIVE_MESSAGE_MODE: "queue",
  POCKET_UPLOAD_REPLAY: directory,
});
