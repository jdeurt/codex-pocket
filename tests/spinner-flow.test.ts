import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { type SpinnerLibrary } from "../src/lib/spinner";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";
type SpinnerConnection = Awaited<ReturnType<typeof spinnerClient>>;

const DIGEST_HEX_LENGTH = 64;
const ANIMATION_FRAMES = 15;
const PERMISSION_MASK = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const TALL_WIDTH = 160;
const TALL_HEIGHT = 40;
const CORRUPT_PREFIX_BYTES = 300;
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_SPINNER_MIB = 8;

const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

await test("spinner tools copy local/upload paths, persist across MCP restarts, reset and delete only managed copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-flow-"));

  let main = await spinnerClient(directory);

  try {
    const spinnerLibrary1 = await main.call("spinner_status");

    assert.equal(spinnerLibrary1.current, null);
    const uploaded = path.join(
      directory,
      "uploads",
      "a".repeat(DIGEST_HEX_LENGTH),
      "00000000-0000-4000-8000-000000000001",
      "original"
    );

    await mkdir(path.dirname(uploaded), { recursive: true });
    await copyFile(fixture, uploaded);
    const bytes = await readFile(uploaded);
    const normalized = path.join(path.dirname(uploaded), "image.png");

    await sharp(bytes).png().toFile(normalized);
    const normalizedBytes = await readFile(normalized);
    const selected = await main.call("spinner_set", { path: uploaded });

    assert.ok(selected.current);
    assert.equal(selected.current.frames, ANIMATION_FRAMES);
    assert.equal(selected.current.mime, "image/gif");
    assert.equal(JSON.stringify(selected).includes(directory), false);
    assert.equal(JSON.stringify(selected).includes("original"), false);
    const id = selected.current.id;
    const managed = path.join(directory, "spinner-assets", id);

    assert.deepEqual(await readFile(managed), bytes);
    const fileInfo2 = await stat(managed);

    assert.equal(fileInfo2.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
    const fileInfo3 = await stat(path.dirname(managed));

    assert.equal(fileInfo3.mode & PERMISSION_MASK, PRIVATE_DIRECTORY_MODE);
    const selectedSpinner4 = await main.call("spinner_set", { path: fixture });

    assert.equal(selectedSpinner4.saved.length, 1);
    await main.client.close();
    main = await spinnerClient(directory);
    assert.deepEqual(await main.call("spinner_status"), selected);
    const resetSpinner5 = await main.call("spinner_reset");

    assert.equal(resetSpinner5.current, null);
    const spinnerLibrary6 = await main.call("spinner_status");

    assert.equal(spinnerLibrary6.saved.length, 1);
    await main.call("spinner_delete", { id });
    await assert.rejects(stat(managed));
    assert.deepEqual(await readFile(uploaded), bytes);
    assert.deepEqual(await readFile(normalized), normalizedBytes);
    const local = path.join(directory, "mutable-local.gif");

    await copyFile(uploaded, local);
    const second = await main.call("spinner_set", { path: local });

    assert.ok(second.current);
    await writeFile(local, "source may change after copying");
    assert.deepEqual(await readFile(path.join(directory, "spinner-assets", second.current.id)), bytes);
    const deletedSpinner7 = await main.call("spinner_delete", { id: second.current.id });

    assert.equal(deletedSpinner7.current, null);
    assert.equal(await readFile(local, "utf8"), "source may change after copying");
    assert.deepEqual(await readFile(uploaded), bytes);
    const spinnerLibrary8 = await main.call("spinner_status");

    assert.deepEqual(spinnerLibrary8.saved, []);

    for (const format of ["png", "jpeg", "webp"] as const) {
      const filename = path.join(directory, `wide.${format}`);

      await sharp({ create: { width: 160, height: 40, channels: 3, background: "red" } })
        .toFormat(format)
        .toFile(filename);
      const result = await main.call("spinner_set", { path: filename });

      assert.equal(result.current?.width, TALL_WIDTH);
      assert.equal(result.current.height, TALL_HEIGHT);
    }

    const webp = path.join(directory, "animated.webp");

    await sharp(bytes, { animated: true }).webp().toFile(webp);
    const selectedSpinner9 = await main.call("spinner_set", { path: webp });

    assert.equal(selectedSpinner9.current?.frames, ANIMATION_FRAMES);
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
