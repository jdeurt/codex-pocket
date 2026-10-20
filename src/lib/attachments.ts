import { z } from "zod";

const KIB = 1024;
const MIB = KIB * KIB;
const MAX_FILE_MIB = 25;
const MAX_TOTAL_MIB = 50;
export const MAX_FILE_BYTES = MAX_FILE_MIB * MIB;
export const MAX_ATTACHMENT_BYTES = MAX_TOTAL_MIB * MIB;
export const MAX_ATTACHMENTS = 10;

export const fileAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nonnegative(),
  mediaType: z.string(),
  kind: z.enum(["image", "file"]),
});

export type FileAttachment = z.infer<typeof fileAttachmentSchema>;

/**
Build a URL for an existing upload or its preview representation.
@param id - Durable upload identifier returned by the server.
@param [isPreview] - Whether the endpoint should return a preview.
@returns The encoded same-origin upload URL.
*/
export const attachmentUrl = (id: string, isPreview = false) =>
  `/api/uploads?id=${encodeURIComponent(id)}${isPreview ? "&preview=1" : ""}`;

/**
Format attachment bytes using the existing binary KB and MB thresholds.
@param bytes - File length in bytes.
@returns A compact byte, rounded KB, or one-decimal MB label.
*/
export function fileSize(bytes: number) {
  if (bytes < KIB) {
    return `${String(bytes)} B`;
  }

  return bytes < MIB ? `${String(Math.ceil(bytes / KIB))} KB` : `${(bytes / MIB).toFixed(1)} MB`;
}
