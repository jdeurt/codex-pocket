import { createRotatingLogStream, redactLog } from "../src/server/logging";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { finished } from "node:stream/promises";
import { object } from "../src/lib/protocol";
import path from "node:path";
import pino from "pino";
import test from "node:test";
import { tmpdir } from "node:os";

const MAX_BYTES = 512;
const RECORDS = 25;
const KEEP_ALL = 100;
const KEEP_RECENT = 2;
const PRIVATE_FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;

async function writeRecords(directory: string, retention: number) {
  const stream = createRotatingLogStream(directory, MAX_BYTES, retention);
  const logger = pino(
    {
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { log: (fields) => redactLog(fields) },
    },
    stream
  );

  for (let index = 0; index < RECORDS; index++) {
    logger.info({ index, password: "private-value" }, "record");
  }

  stream.end();
  await finished(stream);
}

await test("size rotation preserves whole JSON records in private files named with ISO creation timestamps", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-logs-"));

  try {
    const records: Record<string, unknown>[] = [];

    await writeRecords(directory, KEEP_ALL);
    const names = await readdir(directory);

    assert.ok(names.length > 1);

    for (const name of names) {
      assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.jsonl$/);
      const file = path.join(directory, name);
      const info = await stat(file);

      assert.equal(info.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
      assert.ok(info.size <= MAX_BYTES);
      const contents = await readFile(file, "utf8");

      records.push(
        ...contents
          .trim()
          .split("\n")
          .map((line) => object(JSON.parse(line)))
      );
    }

    assert.equal(records.length, RECORDS);
    assert.ok(records.every((record) => record.password === "[REDACTED]"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("retention keeps only the configured number of recent log files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pocket-retention-"));

  try {
    await writeRecords(directory, KEEP_RECENT);
    const files = await readdir(directory);

    assert.equal(files.length, KEEP_RECENT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("redaction covers nested credentials while retaining message and error diagnostics", () => {
  const redacted = redactLog({
    message: "Hello",
    keys: { auth: "secret", privateKey: "secret" },
    headers: { Authorization: "secret" },
    error: new Error("Broken"),
  });

  assert.equal(redacted.message, "Hello");
  assert.equal(JSON.stringify(redacted).includes('"secret"'), false);
  assert.match(JSON.stringify(redacted), /Broken/);
});
