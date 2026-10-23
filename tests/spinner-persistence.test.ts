import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

const ANIMATION_FRAMES = 15;
const MODE_MASK = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

await test("spinner selection survives an MCP restart and deletes only its managed copy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-persistence-"));
  const uploaded = path.join(directory, "uploads", "original.gif");
  const source = await readFile(fixture);

  let main = await spinnerClient(directory);

  try {
    await mkdir(path.dirname(uploaded));
    await copyFile(fixture, uploaded);
    const selected = await main.call("spinner_set", { path: uploaded });
    const asset = selected.current;

    assert.ok(asset);
    assert.equal(asset.frames, ANIMATION_FRAMES);
    assert.equal(asset.mime, "image/gif");
    const managed = path.join(directory, "spinner-assets", asset.id);

    assert.deepEqual(await readFile(managed), source);
    const assetInfo = await stat(managed);
    const directoryInfo = await stat(path.dirname(managed));
    const deduplicated = await main.call("spinner_set", { path: fixture });

    assert.equal(assetInfo.mode & MODE_MASK, PRIVATE_FILE_MODE);
    assert.equal(directoryInfo.mode & MODE_MASK, PRIVATE_DIRECTORY_MODE);
    assert.equal(deduplicated.saved.length, 1);
    await main.client.close();
    main = await spinnerClient(directory);
    assert.deepEqual(await main.call("spinner_status"), selected);
    await writeFile(uploaded, "The source can change after selection.");
    assert.deepEqual(await readFile(managed), source);
    const reset = await main.call("spinner_reset");

    assert.equal(reset.current, null);
    assert.equal(reset.saved.length, 1);
    await main.call("spinner_delete", { id: asset.id });
    const empty = await main.call("spinner_status");

    assert.deepEqual(empty.saved, []);
    await assert.rejects(stat(managed), { code: "ENOENT" });
    assert.equal(await readFile(uploaded, "utf8"), "The source can change after selection.");
  } finally {
    await main.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
