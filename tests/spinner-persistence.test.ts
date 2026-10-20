import { type SavedSpinner, type SpinnerLibrary } from "../src/lib/spinner";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spinnerClient } from "./fixtures/spinner-client";
import test from "node:test";

type SpinnerConnection = Awaited<ReturnType<typeof spinnerClient>>;
interface OriginalFiles {
  uploaded: string;
  normalized: string;
  bytes: Buffer;
  normalizedBytes: Buffer;
}
interface ManagedCopy {
  id: string;
  managed: string;
}
const DIGEST_HEX_LENGTH = 64;
const ANIMATION_FRAMES = 15;
const PERMISSION_MASK = 0o777;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const TALL_WIDTH = 160;
const TALL_HEIGHT = 40;
const fixture = path.resolve("tests/fixtures/spinners/kirbyjam.gif");

/**
Owns the current real MCP client across the persisted spinner workflow's native restart.
*/
class SpinnerPersistenceReplay {
  private local: string;

  /**
  Binds private files and the already connected native MCP client to this workflow.
  @param directory - Fresh private managed-asset directory.
  @param main - Connected real MCP client whose current replacement is closed by this owner.
  */
  constructor(
    private directory: string,
    private main: SpinnerConnection
  ) {
    this.local = path.join(directory, "mutable-local.gif");
  }

  /**
  Writes the original cached PNG only after reading the original GIF bytes.
  @param bytes - Original uploaded GIF bytes.
  @param normalized - Private existing-normalization fixture path.
  @returns Exact normalized bytes used for the later non-deletion assertion.
  */
  private async normalizedOriginal(bytes: Buffer, normalized: string) {
    await sharp(bytes).png().toFile(normalized);

    return readFile(normalized);
  }

  /**
  Captures both original and normalized bytes after the native upload fixture is copied.
  @param uploaded - Private original upload path.
  @param normalized - Private normalized image path.
  @returns Owned input paths and byte snapshots.
  */
  private async readOriginal(uploaded: string, normalized: string): Promise<OriginalFiles> {
    const bytes = await readFile(uploaded);
    const normalizedBytes = await this.normalizedOriginal(bytes, normalized);

    return { uploaded, normalized, bytes, normalizedBytes };
  }

  /**
  Require an empty preference before creating the original native upload and cached image inputs.
  @returns Owned original and normalized native input paths and byte snapshots.
  */
  private async originalFiles() {
    const uploaded = path.join(
      this.directory,
      "uploads",
      "a".repeat(DIGEST_HEX_LENGTH),
      "00000000-0000-4000-8000-000000000001",
      "original"
    );
    const normalized = path.join(path.dirname(uploaded), "image.png");
    const library = await this.main.call("spinner_status");

    assert.equal(library.current, null);
    await mkdir(path.dirname(uploaded), { recursive: true });
    await copyFile(fixture, uploaded);

    return this.readOriginal(uploaded, normalized);
  }

  /**
  Captures the owned copy's bytes and native metadata before checking privacy and identity.
  @param original - Input byte snapshots that remain owned by the upload workflow.
  @param asset - Canonical selected native asset, already required by the caller.
  @returns Managed asset identity and path used by deletion assertions.
  */
  private async inspectCopy(original: OriginalFiles, asset: SavedSpinner): Promise<ManagedCopy> {
    const managed = path.join(this.directory, "spinner-assets", asset.id);
    const bytes = await readFile(managed);
    const fileInfo = await stat(managed);
    const directoryInfo = await stat(path.dirname(managed));

    assert.deepEqual(bytes, original.bytes);
    assert.equal(fileInfo.mode & PERMISSION_MASK, PRIVATE_FILE_MODE);
    assert.equal(directoryInfo.mode & PERMISSION_MASK, PRIVATE_DIRECTORY_MODE);

    return { id: asset.id, managed };
  }

  /**
  Requires the original animation and sanitized library before inspecting its native managed copy.
  @param selected - Canonical native selection result.
  @param original - Owned original upload and normalized bytes.
  @returns Verified managed asset identity and path.
  */
  private inspectOriginal(selected: SpinnerLibrary, original: OriginalFiles) {
    assert.ok(selected.current);
    assert.equal(selected.current.frames, ANIMATION_FRAMES);
    assert.equal(selected.current.mime, "image/gif");
    assert.equal(JSON.stringify(selected).includes(this.directory), false);
    assert.equal(JSON.stringify(selected).includes("original"), false);

    return this.inspectCopy(original, selected.current);
  }

  /**
  Requires content deduplication before closing and replacing the actual MCP process connection.
  @param deduplicated - Canonical result from selecting the same original bytes a second time.
  @returns Canonical library loaded through the replacement native process.
  */
  private async restartAfterDeduplication(deduplicated: SpinnerLibrary) {
    assert.equal(deduplicated.saved.length, 1);
    await this.main.client.close();
    this.main = await spinnerClient(this.directory);

    return this.main.call("spinner_status");
  }

  /**
  Requires exact persisted state before resetting the current preference.
  @param restored - Canonical library read after the native restart.
  @param selected - Original canonical selection result.
  @returns Canonical reset result.
  */
  private resetRestored(restored: SpinnerLibrary, selected: SpinnerLibrary) {
    assert.deepEqual(restored, selected);

    return this.main.call("spinner_reset");
  }

  /**
  Requires reset to clear only the current selection before reading the retained catalog.
  @param reset - Canonical native reset response.
  @returns Native saved catalog after reset.
  */
  private savedAfterReset(reset: SpinnerLibrary) {
    assert.equal(reset.current, null);

    return this.main.call("spinner_status");
  }

  /**
  Deletes only the managed copy, verifies both upload inputs, then selects an independent mutable source.
  @param saved - Canonical catalog after reset.
  @param managed - Verified managed copy selected earlier.
  @param original - Original upload and normalized bytes that must remain untouched.
  @returns Native selection of the independent mutable local file.
  */
  private async copyMutableSource(saved: SpinnerLibrary, managed: ManagedCopy, original: OriginalFiles) {
    assert.equal(saved.saved.length, 1);
    await this.main.call("spinner_delete", { id: managed.id });
    await assert.rejects(stat(managed.managed));
    assert.deepEqual(await readFile(original.uploaded), original.bytes);
    assert.deepEqual(await readFile(original.normalized), original.normalizedBytes);
    await copyFile(original.uploaded, this.local);

    return this.main.call("spinner_set", { path: this.local });
  }

  /**
  Mutates the independent source and requires the managed copy to retain the original GIF bytes.
  @param selected - Canonical mutable-source selection.
  @param original - Original immutable upload byte snapshots.
  @returns Native deletion result for that managed copy.
  */
  private async deleteMutableCopy(selected: SpinnerLibrary, original: OriginalFiles) {
    assert.ok(selected.current);
    await writeFile(this.local, "source may change after copying");
    assert.deepEqual(await readFile(path.join(this.directory, "spinner-assets", selected.current.id)), original.bytes);

    return this.main.call("spinner_delete", { id: selected.current.id });
  }

  /**
  Requires managed deletion to retain the changed local source and original upload before reading the empty catalog.
  @param deleted - Canonical deletion result.
  @param original - Original upload bytes and paths.
  @returns Native catalog after both managed copies were deleted.
  */
  private async catalogAfterDeletion(deleted: SpinnerLibrary, original: OriginalFiles) {
    assert.equal(deleted.current, null);
    assert.equal(await readFile(this.local, "utf8"), "source may change after copying");
    assert.deepEqual(await readFile(original.uploaded), original.bytes);

    return this.main.call("spinner_status");
  }

  /**
  Creates one real raster format before its native selection.
  @param format - Existing raster variant exercised by this workflow.
  @returns Private original raster path.
  */
  private async rasterInput(format: "png" | "jpeg" | "webp") {
    const filename = path.join(this.directory, `wide.${format}`);

    await sharp({ create: { width: 160, height: 40, channels: 3, background: "red" } })
      .toFormat(format)
      .toFile(filename);

    return filename;
  }

  /**
  Converts the original animation to WebP before selecting its native path.
  @param bytes - Original animated GIF bytes.
  @returns Canonical native selection of the animated WebP.
  */
  private async animatedSelection(bytes: Buffer) {
    const webp = path.join(this.directory, "animated.webp");

    await sharp(bytes, { animated: true }).webp().toFile(webp);

    return this.main.call("spinner_set", { path: webp });
  }

  /**
  Requires an empty catalog before checking original raster dimensions and animated frame count.
  @param empty - Canonical catalog after managed-copy deletion.
  @param original - Original animated input bytes.
  */
  private async checkFormats(empty: SpinnerLibrary, original: OriginalFiles) {
    assert.deepEqual(empty.saved, []);

    for (const format of ["png", "jpeg", "webp"] as const) {
      const filename = await this.rasterInput(format);
      const result = await this.main.call("spinner_set", { path: filename });

      assert.equal(result.current?.width, TALL_WIDTH);
      assert.equal(result.current.height, TALL_HEIGHT);
    }

    assert.partialDeepStrictEqual(await this.animatedSelection(original.bytes), {
      current: { frames: ANIMATION_FRAMES },
    });
  }

  /**
  Close the current native MCP client, including its replacement after restart.
  */
  async close() {
    await this.main.client.close();
  }

  /**
  Exercise original-byte copying, native persistence/reset/deletion and format preservation in order.
  */
  async check() {
    const original = await this.originalFiles();
    const selected = await this.main.call("spinner_set", { path: original.uploaded });
    const managed = await this.inspectOriginal(selected, original);
    const deduplicated = await this.main.call("spinner_set", { path: fixture });
    const restored = await this.restartAfterDeduplication(deduplicated);
    const reset = await this.resetRestored(restored, selected);
    const saved = await this.savedAfterReset(reset);
    const second = await this.copyMutableSource(saved, managed, original);
    const deleted = await this.deleteMutableCopy(second, original);
    const empty = await this.catalogAfterDeletion(deleted, original);

    await this.checkFormats(empty, original);
  }
}

await test("spinner tools copy local/upload paths, persist across MCP restarts, reset and delete only managed copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spinner-flow-"));
  const replay = new SpinnerPersistenceReplay(directory, await spinnerClient(directory));

  try {
    await replay.check();
  } finally {
    await replay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
