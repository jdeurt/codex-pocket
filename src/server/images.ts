import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { log } from "./logging";
import path from "node:path";
import sharp from "sharp";

const MAX_INPUT_BYTES = 26_214_400;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_CACHE_BYTES = 33_554_432;
const THUMBNAIL_SIZE = 960;
const PREVIEW_SIZE = 4096;
const THUMBNAIL_QUALITY = 82;
const PREVIEW_QUALITY = 92;
const RASTER_FORMATS = new Set(["png", "jpeg", "webp", "gif", "avif", "heif", "tiff"]);

interface RenderedImage {
  bytes: Buffer;
  etag: string;
}
const cache = new Map<string, RenderedImage>();

async function inputImage(source: string, cwd: string) {
  if (source.startsWith("data:image/")) {
    const match = /^data:image\/[\w.+-]+;base64,([\s\S]+)$/.exec(source);

    if (!match || source.length > MAX_INPUT_BYTES * 2) {
      throw new Error("Invalid or oversized inline image.");
    }

    return Buffer.from(match[1], "base64");
  }

  if (/^[a-z][\w+.-]*:/i.test(source) && !source.startsWith("file:")) {
    throw new Error("Only local image files and inline image output are served by this endpoint.");
  }

  const filename = source.startsWith("file:") ? fileURLToPath(source) : path.resolve(cwd, source);
  const info = await stat(/* turbopackIgnore: true */ filename);

  if (!info.isFile() || info.size > MAX_INPUT_BYTES) {
    throw new Error("Image must be a regular file no larger than 25 MiB.");
  }

  return readFile(/* turbopackIgnore: true */ filename);
}

export async function renderImage(source: string, cwd: string, isThumbnail: boolean) {
  const input = await inputImage(source, cwd);

  if (input.length > MAX_INPUT_BYTES) {
    throw new Error("Image exceeds 25 MiB.");
  }

  const key = createHash("sha256").update(input).update(String(isThumbnail)).digest("hex");
  const cached = cache.get(key);

  if (cached) {
    cache.delete(key);
    cache.set(key, cached);

    return cached;
  }

  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await image.metadata();

  if (!RASTER_FORMATS.has(metadata.format)) {
    throw new Error("This file is not a supported raster image.");
  }

  const size = isThumbnail ? THUMBNAIL_SIZE : PREVIEW_SIZE;
  const bytes = await image
    .rotate()
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .webp({ quality: isThumbnail ? THUMBNAIL_QUALITY : PREVIEW_QUALITY })
    .toBuffer();
  const rendered = { bytes, etag: `"${key}"` };

  cache.set(key, rendered);
  let total = cache.values().reduce((sum, entry) => sum + entry.bytes.length, 0);

  while (total > MAX_CACHE_BYTES && cache.size > 0) {
    const first = cache.keys().next().value;

    if (first === undefined) {
      break;
    }

    total -= cache.get(first)?.bytes.length ?? 0;
    cache.delete(first);
  }

  log().debug(
    {
      source: source.startsWith("data:") ? "inline image" : source,
      inputBytes: input.length,
      outputBytes: bytes.length,
      thumbnail: isThumbnail,
    },
    "image.rendered"
  );

  return rendered;
}
