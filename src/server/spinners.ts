import { valueAfterCleanup } from "../lib/results";
import { findById } from "../lib/identity";
import { COLUMNS, PRIVATE_FILE_MODE, assetInfoSchema, spinnerStorage, storedSpinnerSchema } from "./spinner-db";
import { type ValidatedRaster, rasterFile, validatedRaster } from "./spinner-raster";
import { closeSync, constants, openSync, readFileSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { type SpinnerLibrary } from "../lib/spinner";
import { localDirectory } from "./local-state";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { t as attempt, ok } from "try";

const MAX_SAVED = 32;
const MAX_LIBRARY_BYTES = 67_108_864;
const stores = new Map<string, SpinnerStore>();
export const spinnerId = z.uuid();

/**
Own the managed spinner catalog and original image copies.
*/
export class SpinnerStore {
  private db: Database.Database;

  private assets: string;

  /**
Open private managed assets and their native catalog.
@param directory - Private Pocket state directory.
*/
  constructor(directory: string) {
    const storage = spinnerStorage(directory);

    this.assets = storage.assets;
    this.db = storage.db;
  }

  /**
Select an existing digest or insert its managed image inside the active transaction.
@param id - New managed asset identifier.
@param digest - SHA-256 digest of the original bytes.
@param raster - Validated original image and derived metadata.
@returns Whether the new file became a catalog asset.
*/
  private registerAsset(id: string, digest: string, raster: ValidatedRaster) {
    const existing = z
      .object({ id: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT id FROM spinner_assets WHERE digest=?").get(digest));

    if (existing) {
      this.db.prepare("UPDATE spinner_assets SET tone=? WHERE id=?").run(JSON.stringify(raster.tone), existing.id);
      this.db.prepare("UPDATE spinner_preference SET activeId=? WHERE singleton=1").run(existing.id);

      return false;
    }

    return this.insertAsset(id, digest, raster);
  }

  /**
Enforce library capacity before registering a new managed image.
@param id - New managed asset identifier.
@param digest - SHA-256 digest of the original bytes.
@param raster - Validated original image and derived metadata.
@returns Whether the new file was registered.
*/
  private insertAsset(id: string, digest: string, raster: ValidatedRaster) {
    const { count, bytes } = z
      .object({ count: z.number(), bytes: z.number() })
      .parse(this.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM spinner_assets").get());

    if (count >= MAX_SAVED || bytes + raster.input.length > MAX_LIBRARY_BYTES) {
      throw new Error("Spinner library is full (32 images or 64 MiB). Use spinner_status and spinner_delete first.");
    }

    this.db
      .prepare(
        "INSERT INTO spinner_assets (id,digest,mime,width,height,frames,bytes,createdAt,tone) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(
        id,
        digest,
        raster.mime,
        raster.width,
        raster.height,
        raster.frames,
        raster.input.length,
        Date.now(),
        JSON.stringify(raster.tone)
      );
    this.db.prepare("UPDATE spinner_preference SET activeId=? WHERE singleton=1").run(id);

    return true;
  }

  /**
Validate the managed identifier and decode its stored delivery metadata.
@param id - Managed spinner identifier.
@returns Stored MIME, digest and tone, or undefined for a missing asset.
*/
  private assetMetadata(id: string) {
    spinnerId.parse(id);

    return assetInfoSchema
      .optional()
      .parse(this.db.prepare("SELECT mime,digest,tone FROM spinner_assets WHERE id=?").get(id));
  }

  /**
Read original asset bytes and lazily migrate legacy display tone.
@param file - Open managed-asset file descriptor.
@param id - Managed spinner identifier.
@param asset - Validated catalog delivery metadata.
@returns Original bytes with their MIME and stable cache identity.
*/
  private async assetBytes(file: number, id: string, asset: z.infer<typeof assetInfoSchema>) {
    const bytes = readFileSync(file);

    if (!asset.tone) {
      // Upgrade legacy saved assets on first read, keeping original animation bytes and cache identity.
      const { tone } = await validatedRaster(bytes);

      this.db.prepare("UPDATE spinner_assets SET tone=? WHERE id=? AND tone IS NULL").run(JSON.stringify(tone), id);
    }

    return { bytes, mime: asset.mime, etag: `"${asset.digest}"` };
  }

  /**
Keep the managed file open until its read and any tone migration finish.
@param id - Managed spinner identifier.
@param asset - Validated catalog delivery metadata.
@returns Original bytes with MIME and cache identity.
*/
  private async readManagedAsset(id: string, asset: z.infer<typeof assetInfoSchema>) {
    const file = openSync(path.join(this.assets, id), constants.O_RDONLY | constants.O_NOFOLLOW);

    const completed = await attempt(this.assetBytes(file, id, asset));

    return valueAfterCleanup(completed, attempt(closeSync, file));
  }

  /** Remove a registered file and its metadata under the caller's native transaction.
  @param id - Validated managed image identity.
  */
  private deleteAsset(id: string) {
    const asset = this.db.prepare("SELECT id FROM spinner_assets WHERE id=?").get(id);

    if (!asset) {
      throw new Error("Saved spinner not found. Use spinner_status for managed IDs.");
    }

    this.db.prepare("UPDATE spinner_preference SET activeId=NULL WHERE singleton=1 AND activeId=?").run(id);

    const removed = attempt(unlinkSync, path.join(this.assets, id));

    if (!removed.ok) {
      const error = removed.error;

      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Could not delete the managed spinner copy. Try again.", { cause: error });
      }
    }

    this.db.prepare("DELETE FROM spinner_assets WHERE id=?").run(id);
  }

  /**
Read the saved library and resolve the active managed spinner.
@returns The current selection and saved assets in creation order.
*/
  status(): SpinnerLibrary {
    const assets = z
      .array(storedSpinnerSchema)
      .parse(this.db.prepare(`SELECT ${COLUMNS} FROM spinner_assets ORDER BY createdAt,id`).all());
    const { activeId } = z
      .object({ activeId: z.string().nullable() })
      .parse(this.db.prepare("SELECT activeId FROM spinner_preference WHERE singleton=1").get());

    return { current: findById(assets, activeId) ?? null, saved: assets };
  }

  /**
Save validated original bytes and atomically select their catalog entry.
@param filename - Absolute local image path.
@returns The updated spinner library.
*/
  async set(filename: string) {
    const raster = await rasterFile(filename);
    const id = randomUUID();
    const digest = createHash("sha256").update(raster.input).digest("hex");
    const target = path.join(this.assets, id);

    await writeFile(target, raster.input, { mode: PRIVATE_FILE_MODE, flag: "wx" });

    const hasRegistered = this.db.transaction(this.registerAsset.bind(this));
    const outcome = attempt(hasRegistered.immediate.bind(hasRegistered), id, digest, raster);
    const removed = outcome.ok && outcome.value ? ok(undefined) : attempt(unlinkSync, target);

    valueAfterCleanup(outcome, removed);

    return this.status();
  }

  /**
Clear the active spinner without deleting saved images.
@returns The library using the default spinner.
*/
  reset() {
    this.db.prepare("UPDATE spinner_preference SET activeId=NULL WHERE singleton=1").run();

    return this.status();
  }

  /**
Remove a managed image and clear its selection inside the catalog transaction.
@param id - Managed spinner identifier.
@returns The deleted identifier and updated library.
*/
  delete(id: string) {
    spinnerId.parse(id);
    this.db.transaction(this.deleteAsset.bind(this)).immediate(id);

    return { deletedId: id, ...this.status() };
  }

  /**
Resolve a managed spinner before opening its private image copy.
@param id - Managed spinner identifier.
@returns Original bytes with MIME and cache identity.
*/
  async asset(id: string) {
    const asset = this.assetMetadata(id);

    if (!asset) {
      throw new Error("Spinner unavailable.");
    }

    return this.readManagedAsset(id, asset);
  }

  /**
Release the native spinner catalog connection.
*/
  close() {
    this.db.close();
  }
}

/**
Reuse the spinner store for the current private state directory.
@returns The directory's process-local spinner store.
*/
export function spinners() {
  const directory = localDirectory();

  let store = stores.get(directory);

  if (!store) {
    store = new SpinnerStore(directory);
    stores.set(directory, store);
  }

  return store;
}
