import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runNextFixture } from "./next-server";
import { realtimeProvider } from "./realtime-provider";

const origin = "http://127.0.0.1:3119";
const directory = path.resolve(".local/realtime-fixture");

await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "control.json"), "{}");
await writeFile(path.join(directory, "native.jsonl"), "");
await writeFile(path.join(directory, "provider.jsonl"), "");
await mkdir(path.join(directory, "state"), { recursive: true });
await writeFile(
  path.join(directory, "state/settings.json"),
  JSON.stringify({ openaiApiKey: "dummy-openai-key-for-local-fixture" })
);
const provider = await realtimeProvider();

try {
  await runNextFixture("realtime", origin, {
    OPENAI_API_KEY: "",
    POCKET_REALTIME_TEST_URL: provider.url,
    CODEX_THREAD_ID: "realtime-fixture-parent",
    CODEX_CWD: process.cwd(),
    CODEX_BINARY: process.execPath,
    CODEX_SERVER_ARGS: JSON.stringify(["--import", "tsx", "tests/fixtures/realtime-rpc.ts"]),
    CODEX_ALLOWED_ORIGINS: origin,
    CODEX_POCKET_STATE_DIR: path.join(directory, "state"),
    CLAUDE_CONFIG_DIR: path.join(directory, "claude"),
  });
} finally {
  for (const client of provider.server.clients) {
    client.terminate();
  }

  provider.server.close();
  provider.http.close();
}

if (provider.failures.length > 0) {
  throw new Error(provider.failures.join("\n"));
}
