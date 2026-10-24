import {
  type StoredUpload,
  storedUploadSchema,
  MAX_NAME_LENGTH,
  MAX_MEDIA_TYPE_LENGTH,
  publicUpload,
  sameUpload,
  isValidName,
  isImageUpload,
} from "../state/uploads";

export { publicUpload, assertMessageContent } from "../state/uploads";
import { valueAfterCleanup } from "../lib/results";
import { t as captureResult } from "try";
import { type FileAttachment, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../lib/attachments";
import { localDirectory, readLocal, writeLocal } from "./local-state";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { writeBytes } from "./upload-body";
import { z } from "zod";

const uuid = z.uuid();
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_EDGE = 2048;
const rasterFormats = new Set(["png", "jpeg", "webp", "gif", "avif", "heif", "tiff"]);

/**
Resolve a validated upload ID inside its parent chat's private namespace.
@param parent - Owning chat identifier.
@param id - Caller-supplied upload identifier.
@returns The private managed directory.
*/
function directory(parent: string, id: string) {
  uuid.parse(id);

  return path.join(localDirectory(), "uploads", createHash("sha256").update(parent).digest("hex"), id);
}

/**
Resolve the original attachment or normalized model-input image.
@param parent - Owning chat identifier.
@param file - Validated attachment metadata.
@param isImage - Whether to resolve the normalized PNG instead of original bytes.
@returns The managed local file path.
*/
export function uploadPath(parent: string, file: FileAttachment, isImage = false) {
  return path.join(directory(parent, file.id), isImage ? "image.png" : "original");
}

/**
Decode persisted attachment metadata within the owning chat.
@param parent - Owning chat identifier.
@param id - Managed upload identifier.
@returns The validated persisted attachment and original digest.
*/
export async function getUpload(parent: string, id: string): Promise<StoredUpload> {
  const metadata = await readLocal(path.join(directory(parent, id), "metadata.json"), null);
  const file = storedUploadSchema.nullable().parse(metadata);

  if (!file) {
    throw new Error("This file is unavailable in this chat. Choose it again.");
  }

  return file;
}

/**
Decode a supported photo into bounded PNG input for the model.
@param pending - Pending directory containing immutable original bytes.
*/
async function normalizedRaster(pending: string) {
  const image = sharp(path.join(pending, "original"), { limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
  const metadata = await image.metadata();

  if (!rasterFormats.has(metadata.format)) {
    throw new Error("Unsupported raster image.");
  }

  await image
    .rotate()
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
    .png()
    .toFile(path.join(pending, "image.png"));
}

/**
Atomically publish complete bytes and metadata, accepting an identical concurrent commit.
@param parent - Owning chat identifier.
@param pending - Completed pending directory.
@param file - Validated upload and original digest.
*/
async function commitUpload(parent: string, pending: string, file: StoredUpload) {
  await writeLocal(path.join(pending, "metadata.json"), file);

  const completed = await captureResult(rename(pending, directory(parent, file.id)));

  if (completed.ok) {
    return;
  }

  const error = completed.error;

  if (!(error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) {
    throw error;
  }

  const existing = await captureResult(getUpload, parent, file.id);

  if (!existing.ok) {
    throw new AggregateError(
      [error, existing.error],
      "Upload could not be committed or verified as an identical retry."
    );
  }

  sameUpload(file, existing.value);
}

/**
Resolve retries before deriving model input and committing a new attachment.
@param parent - Owning chat identifier.
@param pending - Unique pending directory.
@param id - Validated upload identifier.
@param request - Incoming body request.
@param name - Validated display name.
@param mediaType - Validated request media type.
@returns The committed public attachment.
*/
async function persistUpload(
  parent: string,
  pending: string,
  id: string,
  request: Request,
  name: string,
  mediaType: string
) {
  const { size, sha256 } = await writeBytes(request, pending);
  const kind = isImageUpload(name, mediaType) ? "image" : "file";
  const file: StoredUpload = { id, name, size, mediaType, kind, sha256 };
  const metadata = await readLocal(path.join(directory(parent, id), "metadata.json"), null);
  const existing = storedUploadSchema.nullable().parse(metadata);

  if (existing) {
    sameUpload(file, existing);

    return publicUpload(existing);
  }

  if (kind === "image") {
    const normalized = await captureResult(normalizedRaster, pending);

    if (!normalized.ok) {
      throw new Error(
        "This image couldn't be read. Try a PNG, JPEG, WebP, GIF, or AVIF image, or choose another file.",
        { cause: normalized.error }
      );
    }
  }

  await commitUpload(parent, pending, file);

  return publicUpload(file);
}

/**
Validate attachment metadata and always remove its temporary directory.
@param parent - Owning chat identifier.
@param id - Caller-supplied managed upload identifier.
@param request - Incoming upload request.
@returns The committed public attachment.
*/
export async function saveUpload(parent: string, id: string, request: Request) {
  const url = new URL(request.url);
  const name = z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine(isValidName, "Choose a file with a valid name.")
    .parse(url.searchParams.get("name"));
  const requestedType = url.searchParams.get("type");
  const mediaType = z
    .string()
    .max(MAX_MEDIA_TYPE_LENGTH)
    .regex(/^[\w.+-]+\/[\w.+-]+$/)
    .parse(requestedType?.length ? requestedType : "application/octet-stream");
  const pending = `${directory(parent, id)}.${crypto.randomUUID()}.tmp`;

  const completed = await captureResult(persistUpload, parent, pending, id, request, name, mediaType);

  return valueAfterCleanup(completed, await captureResult(rm, pending, { recursive: true, force: true }));
}

/** Verify one managed file before accepting it as model input.
@param parent - Authorized native chat.
@param id - Managed upload identity.
@returns Public metadata after native file verification.
*/
async function verifiedUpload(parent: string, id: string) {
  const file = await getUpload(parent, id);
  const info = await stat(uploadPath(parent, file));

  if (!info.isFile() || info.size !== file.size) {
    throw new Error(`Choose ${file.name} again; its stored file is unavailable.`);
  }

  return publicUpload(file);
}

/**
Verify stored files and the aggregate byte limit before message submission.
@param parent - Owning chat identifier.
@param ids - Distinct managed upload identifiers.
@returns Validated public attachments in request order.
*/
async function resolvedUploads(parent: string, ids: string[]) {
  const files = await Promise.all(Array.from(ids, verifiedUpload.bind(undefined, parent)));

  let bytes = 0;

  for (const file of files) {
    bytes += file.size;
  }

  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachments must total 50 MB or less.");
  }

  return files;
}

/**
Enforce attachment count and uniqueness before reading private files.
@param parent - Owning chat identifier.
@param ids - Requested managed upload identifiers.
@returns Validated public attachments in request order.
*/
export async function resolveUploads(parent: string, ids: string[]) {
  if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) {
    throw new Error("Attach up to 10 different files.");
  }

  return resolvedUploads(parent, ids);
}

/**
Read an original attachment from its owning chat namespace.
@param parent - Owning chat identifier.
@param id - Managed upload identifier.
@returns Validated metadata and original bytes.
*/
export async function downloadUpload(parent: string, id: string) {
  const file = await getUpload(parent, id);

  return { file, bytes: await readFile(uploadPath(parent, file)) };
}

/**
Build native model input using managed paths while retaining original file information.
@param parent - Owning chat identifier.
@param files - Validated public attachments.
@returns Native image and text input entries in attachment order.
*/
export function attachmentInput(parent: string, files: FileAttachment[]) {
  const input = [];

  for (const file of files) {
    if (file.kind === "image") {
      input.push({ type: "localImage", path: uploadPath(parent, file, true) });
    }

    input.push({
      type: "text",
      text: `Attached file on this computer (read it using your file tools):\n${JSON.stringify({ name: file.name, mediaType: file.mediaType, size: file.size, path: uploadPath(parent, file) })}`,
      text_elements: [],
    });
  }

  return input;
}
