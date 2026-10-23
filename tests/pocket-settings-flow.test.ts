import { GET, POST } from "../src/app/api/settings/route";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readOpenAIApiKey, readPocketSettings } from "../src/server/pocket-settings";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { pocketSettingsSchema } from "../src/lib/settings";
import { promisify } from "node:util";
import test from "node:test";
import { tmpdir } from "node:os";

const ORIGIN = "http://127.0.0.1:3000";
const SAVED_KEY = "sk-pocket-synthetic-settings-only";
const ENVIRONMENT_KEY = "sk-pocket-synthetic-environment-only";
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const BAD_REQUEST = 400;
const run = promisify(execFile);

/** Dispatch a real settings mutation through host/origin checks and private persistence.
@param input - JSON body supplied by the browser.
@param origin - Explicit browser origin; null omits the required mutation header.
@returns The settings route's native response.
*/
function update(input: unknown, origin: string | null = ORIGIN) {
  return POST(
    new Request(`${ORIGIN}/api/settings`, {
      method: "POST",
      headers: {
        Host: new URL(ORIGIN).host,
        "Content-Type": "application/json",
        ...(origin && { Origin: origin }),
      },
      body: JSON.stringify(input),
    })
  );
}

/** Read settings through the production route without starting any agent process.
@returns The guarded, non-cacheable native response.
*/
function read() {
  return GET(new Request(`${ORIGIN}/api/settings`, { headers: { Host: new URL(ORIGIN).host } }));
}

/** Verify another process sees durable preferences and resolves the saved credential.
@returns Completion of fresh-process assertions without printing credential values.
*/
async function readFromFreshProcess() {
  await run(process.execPath, [
    "--import",
    path.resolve("node_modules/tsx/dist/loader.mjs"),
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
     import { readOpenAIApiKey, readPocketSettings } from './src/server/pocket-settings.ts';
     assert.equal(await readOpenAIApiKey(), ${JSON.stringify(SAVED_KEY)});
     const settings = await readPocketSettings();
     assert.equal(settings.showToolCalls, true);
     assert.equal(settings.realtimeVoice, 'marin');
     assert.equal(settings.realtimeModel, 'gpt-realtime-synthetic');`,
  ]);
}

/** Exercise concurrent partial writes, process restart reads, and credential source changes.
@param directory - Disposable host state directory owned by this business flow.
*/
async function persistSettings(directory: string) {
  const responses = await Promise.all([
    update({ openaiApiKey: ` ${SAVED_KEY} ` }),
    update({ showToolCalls: true }),
    update({ realtimeVoice: " marin ", realtimeModel: "gpt-realtime-synthetic" }),
  ]);

  assert.equal(
    responses.every((response) => response.ok),
    true
  );
  assert.equal(await readOpenAIApiKey(), SAVED_KEY);

  for (const response of responses) {
    pocketSettingsSchema.parse(await response.json());
  }

  const settings = await readPocketSettings();
  const file = await stat(path.join(directory, "settings.json"));

  assert.equal(settings.showToolCalls, true);
  assert.equal(file.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
  await readFromFreshProcess();

  process.env.OPENAI_API_KEY = ENVIRONMENT_KEY;
  assert.equal(await readOpenAIApiKey(), SAVED_KEY);

  const removed = await update({ openaiApiKey: null });

  assert.deepEqual(pocketSettingsSchema.parse(await removed.json()), {
    showToolCalls: true,
    realtimeVoice: "marin",
    realtimeModel: "gpt-realtime-synthetic",
    openaiApiKeyConfigured: true,
    openaiApiKeySource: "environment",
  });
  assert.equal(await readOpenAIApiKey(), ENVIRONMENT_KEY);
  await update({ showToolCalls: false, realtimeVoice: null, realtimeModel: null });
  assert.equal(await readOpenAIApiKey(), ENVIRONMENT_KEY);
  delete process.env.OPENAI_API_KEY;
  assert.equal(await readOpenAIApiKey(), null);
}

/** Preserve malformed storage while keeping its credential-bearing contents out of errors.
@param directory - Disposable settings directory after valid mutation and fallback checks.
*/
async function rejectCorruptStorage(directory: string) {
  const file = path.join(directory, "settings.json");
  const corrupt = `{"openaiApiKey":"${SAVED_KEY}" invalid json`;

  await writeFile(file, corrupt);
  await assert.rejects(readOpenAIApiKey(), { message: "Could not read Pocket settings." });

  const response = await read();
  const failedUpdate = await update({ showToolCalls: true });

  assert.equal(response.status, BAD_REQUEST);
  assert.deepEqual(await response.json(), { error: "Could not load Pocket settings." });
  assert.equal(failedUpdate.status, BAD_REQUEST);
  assert.equal(await readFile(file, "utf8"), corrupt);
}

/** Reject unauthorized and malformed writes while preserving saved state and private diagnostics.
@param directory - Disposable host state directory containing the real settings and request logs.
*/
async function rejectUnsafeRequests(directory: string) {
  const attempts = [
    await update({ openaiApiKey: SAVED_KEY }, "https://foreign.example"),
    await update({ openaiApiKey: SAVED_KEY }, null),
    await update({ openaiApiKey: "" }),
    await update({ openaiApiKey: `${SAVED_KEY}\ninvalid` }),
    await update({ extra: SAVED_KEY }),
    await update({ realtimeVoice: "invalid voice" }),
    await update({ realtimeModel: "" }),
    await POST(
      new Request(`${ORIGIN}/api/settings`, {
        method: "POST",
        headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, "Content-Type": "application/json" },
        body: `{"openaiApiKey":"${SAVED_KEY}`,
      })
    ),
  ];

  for (const response of attempts) {
    assert.equal(response.status, BAD_REQUEST);
    assert.deepEqual(await response.json(), {
      error: "Could not save Pocket settings. Check your input and try again.",
    });
  }

  assert.equal(await readOpenAIApiKey(), null);
  const settings = await readPocketSettings();

  assert.equal(settings.showToolCalls, false);
  await rejectCorruptStorage(directory);

  const logs = await readdir(path.join(directory, "logs"));
  const contents = await Promise.all(logs.map((name) => readFile(path.join(directory, "logs", name), "utf8")));

  assert.equal(contents.join("").includes(SAVED_KEY), false);
  assert.equal(contents.join("").includes(ENVIRONMENT_KEY), false);
  assert.equal(contents.join("").includes("http.failed"), true);
}

await test("settings HTTP flow preserves partial updates, private keys, fresh-process reads and environment fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-settings-flow-"));
  const environment = {
    CODEX_THREAD_ID: "",
    CODEX_POCKET_STATE_DIR: directory,
    CODEX_POCKET_LOG_DIR: path.join(directory, "logs"),
  };
  const names = [...Object.keys(environment), "OPENAI_API_KEY"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  Object.assign(process.env, environment);
  delete process.env.OPENAI_API_KEY;

  try {
    const response = await read();

    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(pocketSettingsSchema.parse(await response.json()), {
      showToolCalls: false,
      realtimeVoice: null,
      realtimeModel: null,
      openaiApiKeyConfigured: false,
      openaiApiKeySource: null,
    });
    await persistSettings(directory);
    await rejectUnsafeRequests(directory);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }

    await rm(directory, { recursive: true, force: true });
  }
});
