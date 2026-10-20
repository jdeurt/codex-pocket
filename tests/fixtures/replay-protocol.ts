import { dataSchema } from "../../src/lib/protocol";
import { z } from "zod";

export const fixtureRequestSchema = z.object({
  method: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  params: dataSchema.default({}),
});
export const replayLogSchema = z.object({
  method: z.string(),
  threadId: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  itemsView: z.string().optional(),
  sortDirection: z.string().optional(),
  limit: z.number().optional(),
});
const nativeImageReceipt = z.object({ type: z.literal("localImage"), path: z.string(), size: z.number() });
const fileReceipt = z.object({
  path: z.string(),
  size: z.number(),
  name: z.string(),
  mediaType: z.string(),
  base64: z.string(),
});
export const uploadRequestSchema = z
  .object({
    method: z.string(),
    clientUserMessageId: z.string(),
    input: z.array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("localImage"), path: z.string() }),
      ])
    ),
    bytes: z.array(z.union([nativeImageReceipt, fileReceipt])),
  })
  .transform((request) => ({ ...request, files: request.bytes.filter((file) => "name" in file) }));
