const KIB = 1024;
const MIB = KIB * KIB;
const MAX_FILE_MIB = 25;
const MAX_TOTAL_MIB = 50;
export const MAX_FILE_BYTES = MAX_FILE_MIB * MIB;
export const MAX_ATTACHMENT_BYTES = MAX_TOTAL_MIB * MIB;
export const MAX_ATTACHMENTS = 10;

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  kind: "image" | "file";
}

export const attachmentUrl = (id: string, preview = false) =>
  `/api/uploads?id=${encodeURIComponent(id)}${preview ? "&preview=1" : ""}`;

export function fileSize(bytes: number) {
  return bytes < KIB ? `${bytes} B` : bytes < MIB ? `${Math.ceil(bytes / KIB)} KB` : `${(bytes / MIB).toFixed(1)} MB`;
}
