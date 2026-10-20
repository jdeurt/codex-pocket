import { dataSchema } from "../../src/lib/protocol";
import { fileAttachmentSchema } from "../../src/lib/attachments";
import { z } from "zod";

export const fixtureRequestSchema = z.object({
  method: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  params: dataSchema.default({}),
});
export const replayLogSchema = z.object({
  method: z.string(),
  stage: z.string().optional(),
  threadId: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  itemsView: z.string().optional(),
  sortDirection: z.string().optional(),
  limit: z.number().optional(),
});
const localImageInputSchema = z.looseObject({ type: z.literal("localImage"), path: z.string() });
const textInputSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
export const fixtureUploadInputSchema = z.discriminatedUnion("type", [textInputSchema, localImageInputSchema]);
export const fixtureFileReferenceSchema = fileAttachmentSchema
  .pick({ name: true, size: true, mediaType: true })
  .extend({ path: z.string() });
const nativeImageReceipt = z.object({ type: z.literal("localImage"), path: z.string(), size: z.number() });
const fileReceipt = fixtureFileReferenceSchema.extend({ base64: z.string() });
export const uploadRequestSchema = z
  .object({
    method: z.string(),
    clientUserMessageId: z.string(),
    input: z.array(fixtureUploadInputSchema),
    bytes: z.array(z.union([nativeImageReceipt, fileReceipt])),
  })
  .transform((request) => ({ ...request, files: request.bytes.filter((file) => "name" in file) }));
