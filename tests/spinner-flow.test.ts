import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

const CORRUPT_PREFIX_BYTES = 300;
const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

/**
Reject an invalid source through the running MCP server.
@param main - Real main-session client.
@param filename - Invalid local or remote source.
*/
async function rejectInput(main: Awaited<ReturnType<typeof spinnerClient>>, filename: string) {
  const result = await main.client.callTool({ name: "spinner_set", arguments: { path: filename } });

  assert.equal(result.isError, true);
}

await test("spinner selection recovers from corrupt and remote input while retaining the selected asset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-input-flow-"));
  const corrupt = path.join(directory, "corrupt.gif");
  const main = await spinnerClient(directory);

  try {
    const selected = await main.call("spinner_set", { path: fixture });

    assert.ok(selected.current);
    const source = await readFile(fixture);

    await writeFile(corrupt, source.subarray(0, CORRUPT_PREFIX_BYTES));

    await rejectInput(main, corrupt);
    await rejectInput(main, "https://example.com/spinner.gif");
    assert.deepEqual(await main.call("spinner_status"), selected);

    await main.call("spinner_reset");
    assert.deepEqual(await main.call("spinner_set", { path: fixture }), selected);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
