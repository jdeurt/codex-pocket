import { type FileAttachment, fileAttachmentSchema } from "../lib/attachments";
import type { Receipt } from "../server/outbox";
import { z } from "zod";

export const MAX_NAME_LENGTH = 240;
export const MAX_MEDIA_TYPE_LENGTH = 120;
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
export const storedUploadSchema = fileAttachmentSchema.extend({ sha256: z.string() });

export type StoredUpload = z.infer<typeof storedUploadSchema>;

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
Reject reuse of an upload ID for different bytes or public metadata.
@param file - Incoming validated upload.
@param other - Previously committed upload with the same ID.
*/
export function sameUpload(file: StoredUpload, other: StoredUpload) {
  if (file.sha256 !== other.sha256 || file.name !== other.name || file.mediaType !== other.mediaType) {
    throw new Error("Upload ID already belongs to another file.");
  }
}

/**
Reject path segments and control characters in attachment display names.
@param value - Proposed attachment display name.
@returns Whether the name is safe for the attachment contract.
*/
export function isValidName(value: string) {
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
export function isImageUpload(name: string, mediaType: string) {
  return (
    rasterTypes.has(mediaType) ||
    (mediaType === "application/octet-stream" && /\.(?:png|jpe?g|webp|gif|avif|hei[cf]|tiff?)$/i.test(name))
  );
}

/** Select the durable identity of one attachment.
@param file - Validated attachment.
@returns Its stable upload identity.
*/
function uploadId(file: FileAttachment) {
  return file.id;
}

/**
Reject reuse of a message ID with different text or attachment order.
@param receipt - Previously persisted submission.
@param text - Proposed message text.
@param ids - Proposed attachment identifiers in order.
*/
export function assertMessageContent(receipt: Receipt, text: string, ids: string[]) {
  const savedIds: string[] = Array.from(receipt.attachments ?? [], uploadId);

  const hasSameFiles = JSON.stringify(savedIds) === JSON.stringify(ids);

  if (!hasSameFiles || receipt.text !== text) {
    throw new Error("Message ID already belongs to different content.");
  }
}
