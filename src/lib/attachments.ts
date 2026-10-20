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

export const attachmentUrl = (id: string, preview = false) =>
  `/api/uploads?id=${encodeURIComponent(id)}${preview ? "&preview=1" : ""}`;

export function fileSize(bytes: number) {
  return bytes < KIB
    ? `${String(bytes)} B`
    : bytes < MIB
      ? `${String(Math.ceil(bytes / KIB))} KB`
      : `${(bytes / MIB).toFixed(1)} MB`;
}
