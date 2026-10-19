import { type FileHandle, open, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { SpinnerLibrary } from "../lib/spinner";
import { localDirectory } from "./local-state";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_BYTES = 8_388_608;
const MAX_DIMENSION = 2048;
const MAX_PIXELS = 32_000_000;
const MAX_FRAMES = 300;
const MAX_SAVED = 32;
const MAX_LIBRARY_BYTES = 67_108_864;
const MIME: Record<string, string> = { gif: "image/gif", png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_LENGTH_BYTES = 4;
const COLUMNS = "id,mime,width,height,frames,bytes,createdAt";
export const spinnerId = z.string().uuid();

async function boundedRaster(file: FileHandle) {
  const info = await file.stat();

  if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) {
    throw new Error("Spinner must be a regular image file between 1 byte and 8 MiB.");
  }

  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let size = 0;

  while (size < buffer.length) {
    const read = await file.read(buffer, size, buffer.length - size, null);

    if (read.bytesRead === 0) {
      break;
    }

    size += read.bytesRead;
  }

  if (size === 0 || size > MAX_BYTES) {
    throw new Error("Spinner must be a regular image file between 1 byte and 8 MiB.");
  }

  return buffer.subarray(0, size);
}

function isAnimatedPng(input: Buffer) {
  let offset = PNG_SIGNATURE_BYTES;

  while (offset + PNG_CHUNK_OVERHEAD <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + PNG_CHUNK_LENGTH_BYTES, offset + PNG_CHUNK_LENGTH_BYTES * 2);

    if (type === "acTL") {
      return true;
    }

    offset += length + PNG_CHUNK_OVERHEAD;
  }

  return false;
}

async function validatedRaster(input: Buffer) {
  const image = sharp(input, { animated: true, limitInputPixels: MAX_PIXELS, failOn: "warning" });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const frames = meta.pages ?? 1;
  const height = meta.pageHeight ?? meta.height ?? 0;
  const mime = MIME[meta.format ?? ""];

  if (
    !mime ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    frames < 1 ||
    frames > MAX_FRAMES ||
    width * height * frames > MAX_PIXELS
  ) {
    throw new Error("Unsupported raster or dimensions.");
  }

  // libvips does not decode APNG animation; reject it rather than validating only its first frame.
  if (meta.format === "png" && isAnimatedPng(input)) {
    throw new Error("APNG is not supported.");
  }

  // Decode all frames to validate truncation/corruption; save the original bytes to retain animation.
  await image.raw().toBuffer();

  return { input, mime, width, height, frames };
}

async function rasterFile(filename: string) {
  if (!path.isAbsolute(filename) || filename.includes("\0")) {
    throw new Error("Provide an absolute local file path, after uploading or downloading the image first.");
  }

  // Open once, refuse symlinks/devices, and bound the read even if the source grows.
  let file;

  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new Error("Cannot read this local file. Choose an existing regular image file, not a symlink.", {
      cause: error,
    });
  }

  let input: Buffer;

  try {
    input = await boundedRaster(file);
  } finally {
    await file.close();
  }

  try {
    return await validatedRaster(input);
  } catch {
    throw new Error(
      "Use a valid GIF, PNG, JPEG or WebP: at most 2048 px per side, 300 frames and 32 million total frame pixels. APNG is unsupported."
    );
  }
}

export class SpinnerStore {
  private db: Database.Database;
  private assets: string;
  constructor(directory: string) {
    this.assets = path.join(directory, "spinner-assets");
    mkdirSync(this.assets, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(this.assets, PRIVATE_DIRECTORY_MODE);
    const filename = path.join(directory, "spinners.sqlite");
    this.db = new Database(filename, { timeout: 3000 });
    chmodSync(filename, PRIVATE_FILE_MODE);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spinner_assets (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, mime TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, frames INTEGER NOT NULL,
        bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spinner_preference (singleton INTEGER PRIMARY KEY CHECK(singleton=1), activeId TEXT);
      INSERT OR IGNORE INTO spinner_preference VALUES (1,NULL);
    `);
  }
  status(): SpinnerLibrary {
    const saved = this.db
      .prepare(`SELECT ${COLUMNS} FROM spinner_assets ORDER BY createdAt,id`)
      .all() as SpinnerLibrary["saved"];
    const { activeId } = this.db.prepare("SELECT activeId FROM spinner_preference WHERE singleton=1").get() as {
      activeId: string | null;
    };

    return { current: saved.find((asset) => asset.id === activeId) ?? null, saved };
  }
  async set(filename: string) {
    const { input, ...metadata } = await rasterFile(filename);
    const id = randomUUID();
    const digest = createHash("sha256").update(input).digest("hex");
    const target = path.join(this.assets, id);
    await writeFile(target, input, { mode: PRIVATE_FILE_MODE, flag: "wx" });
    let used = false;

    try {
      this.db
        .transaction(() => {
          const existing = this.db.prepare("SELECT id FROM spinner_assets WHERE digest=?").get(digest) as
            { id: string } | undefined;

          if (existing) {
            this.db.prepare("UPDATE spinner_preference SET activeId=? WHERE singleton=1").run(existing.id);

            return;
          }

          const { count, bytes } = this.db
            .prepare("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM spinner_assets")
            .get() as { count: number; bytes: number };

          if (count >= MAX_SAVED || bytes + input.length > MAX_LIBRARY_BYTES) {
            throw new Error(
              "Spinner library is full (32 images or 64 MiB). Use spinner_status and spinner_delete first."
            );
          }

          this.db
            .prepare("INSERT INTO spinner_assets VALUES (?,?,?,?,?,?,?,?)")
            .run(id, digest, metadata.mime, metadata.width, metadata.height, metadata.frames, input.length, Date.now());
          this.db.prepare("UPDATE spinner_preference SET activeId=? WHERE singleton=1").run(id);
          used = true;
        })
        .immediate();
    } finally {
      if (!used) {
        unlinkSync(target);
      }
    }

    return this.status();
  }
  reset() {
    this.db.prepare("UPDATE spinner_preference SET activeId=NULL WHERE singleton=1").run();

    return this.status();
  }
  delete(id: string) {
    spinnerId.parse(id);
    this.db
      .transaction(() => {
        const asset = this.db.prepare("SELECT id FROM spinner_assets WHERE id=?").get(id);

        if (!asset) {
          throw new Error("Saved spinner not found. Use spinner_status for managed IDs.");
        }

        this.db.prepare("UPDATE spinner_preference SET activeId=NULL WHERE singleton=1 AND activeId=?").run(id);

        try {
          unlinkSync(path.join(this.assets, id));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error("Could not delete the managed spinner copy. Try again.", { cause: error });
          }
        }

        this.db.prepare("DELETE FROM spinner_assets WHERE id=?").run(id);
      })
      .immediate();

    return { deletedId: id, ...this.status() };
  }
  asset(id: string) {
    spinnerId.parse(id);
    const asset = this.db.prepare("SELECT mime,digest FROM spinner_assets WHERE id=?").get(id) as
      { mime: string; digest: string } | undefined;

    if (!asset) {
      throw new Error("Spinner unavailable.");
    }

    const file = openSync(path.join(this.assets, id), constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const bytes = readFileSync(file);

      return { bytes, mime: asset.mime, etag: `"${asset.digest}"` };
    } finally {
      closeSync(file);
    }
  }
  close() {
    this.db.close();
  }
}

const stores = new Map<string, SpinnerStore>();
export function spinners() {
  const directory = localDirectory();
  let store = stores.get(directory);

  if (!store) {
    store = new SpinnerStore(directory);
    stores.set(directory, store);
  }

  return store;
}
