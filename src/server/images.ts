import { readFile, stat } from "node:fs/promises";
import sharp, { type Sharp } from "sharp";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { log } from "./logging";
import path from "node:path";

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

/**
Read a native local image only after validating its protocol, regular-file status and byte size.
@param source - Local path or file URL already checked against non-file protocols.
@param cwd - Owning conversation's native working directory.
@returns Original local image bytes before any display conversion.
*/
async function localImage(source: string, cwd: string) {
  const filename = source.startsWith("file:") ? fileURLToPath(source) : path.resolve(cwd, source);
  const info = await stat(/* turbopackIgnore: true */ filename);

  if (!info.isFile() || info.size > MAX_INPUT_BYTES) {
    throw new Error("Image must be a regular file no larger than 25 MiB.");
  }

  return readFile(/* turbopackIgnore: true */ filename);
}

/**
Decode an allowed inline image or read the owned native local source without remote fetching.
@param source - Native local path, file URL or base64 image data URL.
@param cwd - Owning conversation's native working directory.
@returns Original validated input bytes for the existing display renderer.
*/
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

  return localImage(source, cwd);
}

/**
Bound the rendered image cache by evicting its oldest entries after insertion.
*/
function evictImages() {
  let total = cache.values().reduce((sum, entry) => sum + entry.bytes.length, 0);

  while (total > MAX_CACHE_BYTES && cache.size > 0) {
    const first = cache.keys().next().value;

    if (first === undefined) {
      break;
    }

    total -= cache.get(first)?.bytes.length ?? 0;
    cache.delete(first);
  }
}

/**
Render an allowed raster at the existing display dimensions, quality and orientation.
@param image - Native Sharp pipeline whose input format has already been checked.
@param input - Original input bytes used only for diagnostic byte counts.
@param source - Original native source retained only for existing diagnostics.
@param key - Content and size-mode digest used as cache identity.
@param isThumbnail - Whether the existing thumbnail dimensions and quality are requested.
@returns Cached WebP display bytes and their existing content ETag.
*/
async function convertRaster(image: Sharp, input: Buffer, source: string, key: string, isThumbnail: boolean) {
  const size = isThumbnail ? THUMBNAIL_SIZE : PREVIEW_SIZE;
  const bytes = await image
    .rotate()
    .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
    .webp({ quality: isThumbnail ? THUMBNAIL_QUALITY : PREVIEW_QUALITY })
    .toBuffer();
  const rendered = { bytes, etag: `"${key}"` };

  cache.set(key, rendered);
  evictImages();

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

/**
Validate the native raster format before the existing WebP display conversion.
@param input - Original image bytes within the shared byte limit.
@param source - Native input identity retained for diagnostics.
@param key - Content and size-mode cache digest.
@param isThumbnail - Whether the thumbnail rendering mode is requested.
@returns Rendered display bytes with their cache identity.
*/
async function rasterImage(input: Buffer, source: string, key: string, isThumbnail: boolean) {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await image.metadata();

  if (!RASTER_FORMATS.has(metadata.format)) {
    throw new Error("This file is not a supported raster image.");
  }

  return convertRaster(image, input, source, key, isThumbnail);
}

/**
Reuse a content-addressed display image before starting a native raster decode.
@param input - Original image bytes within the shared limit.
@param source - Native input identity retained for diagnostics.
@param isThumbnail - Whether thumbnail or full preview dimensions are requested.
@returns Existing cached display bytes or a newly validated raster rendering.
*/
async function cachedImage(input: Buffer, source: string, isThumbnail: boolean) {
  const key = createHash("sha256").update(input).update(String(isThumbnail)).digest("hex");
  const cached = cache.get(key);

  if (cached) {
    cache.delete(key);
    cache.set(key, cached);

    return cached;
  }

  return rasterImage(input, source, key, isThumbnail);
}

/**
Read a scoped native image and enforce the original byte limit before cached display rendering.
@param source - Owned local path, file URL or inline image output.
@param cwd - Native working directory of the owning conversation.
@param isThumbnail - Whether the existing thumbnail or full preview rendering is requested.
@returns Rendered WebP bytes and their content ETag.
*/
export async function renderImage(source: string, cwd: string, isThumbnail: boolean) {
  const input = await inputImage(source, cwd);

  if (input.length > MAX_INPUT_BYTES) {
    throw new Error("Image exceeds 25 MiB.");
  }

  return cachedImage(input, source, isThumbnail);
}
