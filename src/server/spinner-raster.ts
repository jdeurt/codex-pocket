import { type FileHandle, open } from "node:fs/promises";
import { type SavedSpinner, type SpinnerTone } from "../lib/spinner";
import sharp, { type Sharp } from "sharp";
import { constants } from "node:fs";
import path from "node:path";
import { spinnerTone } from "./spinner-tone";

const MAX_BYTES = 8_388_608;
const MAX_DIMENSION = 2048;
const MAX_PIXELS = 32_000_000;
const MAX_FRAMES = 300;
const MIME = new Map(Object.entries({ gif: "image/gif", png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }));
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_LENGTH_BYTES = 4;

type RasterDimensions = Pick<SavedSpinner, "mime" | "width" | "height" | "frames">;
export type ValidatedRaster = RasterDimensions & { input: Buffer; tone: SpinnerTone };

/**
Read at most one byte beyond the image limit to detect growing files.
@param file - Open regular-file handle owned by the caller.
@returns The bounded original image bytes.
*/
async function rasterBytes(file: FileHandle) {
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

/**
Reject nonregular or oversized files before allocating the read buffer.
@param file - Open file whose metadata and content will be checked.
@returns The original bytes within the image size limit.
*/
async function boundedRaster(file: FileHandle) {
  const info = await file.stat();

  if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) {
    throw new Error("Spinner must be a regular image file between 1 byte and 8 MiB.");
  }

  return rasterBytes(file);
}

/**
Scan PNG chunk headers for the animation control chunk.
@param input - Complete original PNG bytes.
@returns Whether the image declares APNG animation.
*/
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

/**
Decode every frame to compute display tone while retaining the source bytes.
@param image - Sharp decoder configured for the complete animation.
@param input - Original image bytes to preserve.
@param dimensions - Validated raster dimensions and MIME type.
@returns Validated original bytes and their derived display metadata.
*/
async function decodedRaster(image: Sharp, input: Buffer, dimensions: RasterDimensions): Promise<ValidatedRaster> {
  const pixels = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer();
  const tone = spinnerTone(pixels);

  return { input, ...dimensions, tone };
}

/**
Validate raster dimensions and decode all frames before accepting an image.
@param input - Original encoded raster bytes.
@returns The original bytes with validated metadata and display tone.
*/
export async function validatedRaster(input: Buffer): Promise<ValidatedRaster> {
  const image = sharp(input, { animated: true, limitInputPixels: MAX_PIXELS, failOn: "warning" });
  const meta = await image.metadata();
  const width = meta.width;
  const frames = meta.pages ?? 1;
  const height = meta.pageHeight ?? meta.height;
  const mime = MIME.get(meta.format);

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
  return decodedRaster(image, input, { mime, width, height, frames });
}

/**
Open the requested image without following links or blocking on special files.
@param filename - Absolute local image path.
@returns A file handle that the caller must close.
*/
async function openRasterFile(filename: string) {
  return open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    throw new Error("Cannot read this local file. Choose an existing regular image file, not a symlink.", {
      cause: error,
    });
  });
}

/**
Close the image handle after its bounded read succeeds or fails.
@param file - File handle whose lifetime is owned by this read.
@returns The bounded original image bytes.
*/
async function ownedRasterBytes(file: FileHandle) {
  return boundedRaster(file).finally(async () => {
    await file.close();
  });
}

/**
Read and close the file before normalizing raster decoding failures.
@param filename - Validated absolute local image path.
@returns The validated image and derived display metadata.
*/
async function readRasterFile(filename: string) {
  const file = await openRasterFile(filename);
  const input = await ownedRasterBytes(file);

  return validatedRaster(input).catch(() => {
    throw new Error(
      "Use a valid GIF, PNG, JPEG or WebP: at most 2048 px per side, 300 frames and 32 million total frame pixels. APNG is unsupported."
    );
  });
}

/**
Require a usable absolute path before reading a local spinner image.
@param filename - User-provided local image path.
@returns Validated original bytes and display metadata.
*/
export async function rasterFile(filename: string) {
  if (!path.isAbsolute(filename) || filename.includes("\0")) {
    throw new Error("Provide an absolute local file path, after uploading or downloading the image first.");
  }

  return readRasterFile(filename);
}
