import { type FileAttachment, fileAttachmentSchema } from "./attachments";
import { z } from "zod";

export interface DraftAttachment {
  id: string;
  file: File;
  uploaded?: FileAttachment;
  progress: number;
  error?: string;
}
export interface SavedDraft {
  files: DraftAttachment[];
  pending?: { id: string; text: string };
}
const storedFileSchema = z.object({ name: z.string(), type: z.string(), bytes: z.instanceof(ArrayBuffer) });
const storedAttachmentSchema = z.object({
  id: z.string(),
  progress: z.number(),
  error: z.string().optional(),
  uploaded: fileAttachmentSchema.optional(),
  file: storedFileSchema,
});
export const storedDraftSchema = z.object({
  files: z.array(storedAttachmentSchema),
  pending: z.object({ id: z.string(), text: z.string() }).optional(),
});

export type StoredDraft = z.infer<typeof storedDraftSchema>;
