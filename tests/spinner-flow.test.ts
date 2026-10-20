import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { type SpinnerLibrary } from "../src/lib/spinner";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

type SpinnerConnection = Awaited<ReturnType<typeof spinnerClient>>;

const CORRUPT_PREFIX_BYTES = 300;
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_SPINNER_MIB = 8;

const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

/**
Creates an oversized native input and closes its file handle even when truncation fails.
@param filename - Private oversized fixture path.
*/
async function oversizedInput(filename: string) {
  const file = await open(filename, "w");

  try {
    await file.truncate(MAX_SPINNER_MIB * MIB + 1);
  } finally {
    await file.close();
  }
}

/**
Creates the original invalid native inputs in write order before attempting spinner selection.
@param directory - Private directory owned by the native spinner workflow.
@returns Rejection inputs in their original protocol request order.
*/
async function invalidSpinnerInputs(directory: string) {
  const corrupt = path.join(directory, "corrupt.gif");
  const huge = path.join(directory, "oversize.gif");
  const dimensions = path.join(directory, "too-wide.png");
  const svg = path.join(directory, "untrusted.svg");
  const link = path.join(directory, "symlink.gif");
  const source = await readFile(fixture);

  await writeFile(corrupt, source.subarray(0, CORRUPT_PREFIX_BYTES));
  await oversizedInput(huge);
  await sharp({ create: { width: 2049, height: 1, channels: 3, background: "red" } })
    .png()
    .toFile(dimensions);
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
  await symlink(fixture, link);

  return [
    corrupt,
    huge,
    dimensions,
    svg,
    link,
    directory,
    "/dev/zero",
    path.join(directory, "missing.gif"),
    "relative.gif",
    "https://media.tenor.com/n3OklKSZy1cAAAAj/kirbyjam.gif",
  ];
}

/**
Requires every invalid selection and delete to preserve the original native spinner preference.
@param main - Connected real main MCP client with private state.
@param directory - Private path that must never appear in sanitized failure payloads.
@param before - Canonical preference captured before invalid requests.
@param filenames - Native rejection inputs in their original request order.
*/
async function assertInvalidSpinnerInputs(
  main: SpinnerConnection,
  directory: string,
  before: SpinnerLibrary,
  filenames: string[]
) {
  for (const filename of filenames) {
    const result = await main.client.callTool({ name: "spinner_set", arguments: { path: filename } });

    assert.equal(result.isError, true, filename);
    assert.equal(JSON.stringify(result).includes(directory), false);
    assert.deepEqual(await main.call("spinner_status"), before);
  }

  assert.partialDeepStrictEqual(await main.client.callTool({ name: "spinner_delete", arguments: { id: fixture } }), {
    isError: true,
  });
  assert.deepEqual(await main.call("spinner_status"), before);
}

await test("spinner tool flow rejects invalid, corrupt, oversized and unsafe input without changing the preference", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-invalid-"));
  const main = await spinnerClient(directory);

  try {
    const before = await main.call("spinner_set", { path: fixture });
    const filenames = await invalidSpinnerInputs(directory);

    await assertInvalidSpinnerInputs(main, directory, before, filenames);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
