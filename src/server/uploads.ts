import { t as captureResult } from "try";
import { type FileAttachment, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, fileAttachmentSchema } from "../lib/attachments";
import { localDirectory, readLocal, writeLocal } from "./local-state";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { type Receipt } from "./outbox";
import { type Snapshot } from "../lib/protocol";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { writeBytes } from "./upload-body";
import { z } from "zod";

const uuid = z.uuid();
const MAX_NAME_LENGTH = 240;
const MAX_MEDIA_TYPE_LENGTH = 120;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_EDGE = 2048;
const rasterFormats = new Set(["png", "jpeg", "webp", "gif", "avif", "heif", "tiff"]);
const LAST_CONTROL_CHARACTER = 31;
const DELETE_CHARACTER = 127;
const rasterTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/tiff",
]);
const storedUploadSchema = fileAttachmentSchema.extend({ sha256: z.string() });

type StoredUpload = z.infer<typeof storedUploadSchema>;

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
Project attachment metadata without exposing its private integrity digest.
@param file - Validated stored attachment.
@returns The public attachment contract.
*/
export function publicUpload(file: FileAttachment): FileAttachment {
  const { id, name, size, mediaType, kind } = file;

  return { id, name, size, mediaType, kind };
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
Reject reuse of an upload ID for different bytes or public metadata.
@param file - Incoming validated upload.
@param other - Previously committed upload with the same ID.
*/
function sameUpload(file: StoredUpload, other: StoredUpload) {
  if (file.sha256 !== other.sha256 || file.name !== other.name || file.mediaType !== other.mediaType) {
    throw new Error("Upload ID already belongs to another file.");
  }
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

  if (!completed.ok) {
    sameUpload(file, await getUpload(parent, file.id));
  }
}

/**
Reject path segments and control characters in attachment display names.
@param value - Proposed attachment display name.
@returns Whether the name is safe for the attachment contract.
*/
function isValidName(value: string) {
  if (value === "." || value === "..") {
    return false;
  }

  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;

    if (character === "/" || character === "\\" || point === DELETE_CHARACTER || point <= LAST_CONTROL_CHARACTER) {
      return false;
    }
  }

  return true;
}

/**
Recognize supported image MIME types or generic binary image filenames.
@param name - Validated display name.
@param mediaType - Validated request media type.
@returns Whether model input requires a normalized image.
*/
function isImageUpload(name: string, mediaType: string) {
  return (
    rasterTypes.has(mediaType) ||
    (mediaType === "application/octet-stream" && /\.(?:png|jpe?g|webp|gif|avif|hei[cf]|tiff?)$/i.test(name))
  );
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
        "This image couldn't be read. Try a PNG, JPEG, WebP, GIF, or AVIF image, or choose another file."
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

  const completed = await captureResult(persistUpload(parent, pending, id, request, name, mediaType));

  await rm(pending, { recursive: true, force: true });

  if (!completed.ok) {
    throw completed.error;
  }

  return completed.value;
}

/**
Verify stored files and the aggregate byte limit before message submission.
@param parent - Owning chat identifier.
@param ids - Distinct managed upload identifiers.
@returns Validated public attachments in request order.
*/
async function resolvedUploads(parent: string, ids: string[]) {
  const files = await Promise.all(
    ids.map(async (id) => {
      const file = await getUpload(parent, id);
      const info = await stat(uploadPath(parent, file));

      if (!info.isFile() || info.size !== file.size) {
        throw new Error(`Choose ${file.name} again; its stored file is unavailable.`);
      }

      return publicUpload(file);
    })
  );

  if (files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
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
  return files.flatMap((file) => [
    ...(file.kind === "image" ? [{ type: "localImage", path: uploadPath(parent, file, true) }] : []),
    {
      type: "text",
      text: `Attached file on this computer (read it using your file tools):\n${JSON.stringify({ name: file.name, mediaType: file.mediaType, size: file.size, path: uploadPath(parent, file) })}`,
      text_elements: [],
    },
  ]);
}

/**
Restore receipt-backed attachment metadata on canonical user messages.
@param state - Canonical thread snapshot to update.
@param receipts - Persisted submissions containing attachment metadata.
*/
export function projectAttachments(state: Snapshot, receipts: Receipt[]) {
  const attached = new Map(receipts.filter((entry) => entry.attachments?.length).map((entry) => [entry.id, entry]));

  for (const turn of state.turns) {
    for (const item of turn.items) {
      const receipt = attached.get(String(item.clientId));

      if (!(receipt && item.type === "userMessage")) {
        continue;
      }

      item.attachments = receipt.attachments;
      item.pocketAttachmentText = receipt.text;
    }
  }
}

/**
Reject reuse of a message ID with different text or attachment order.
@param receipt - Previously persisted submission.
@param text - Proposed message text.
@param ids - Proposed attachment identifiers in order.
*/
export function assertMessageContent(receipt: Receipt, text: string, ids: string[]) {
  const hasSameFiles = JSON.stringify(receipt.attachments?.map((file) => file.id) ?? []) === JSON.stringify(ids);

  if (!hasSameFiles || receipt.text !== text) {
    throw new Error("Message ID already belongs to different content.");
  }
}
