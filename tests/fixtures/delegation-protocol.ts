import { dataSchema } from "../../src/lib/protocol";
import { z } from "zod";

const readyEvent = z.object({ event: z.literal("ready") });
const startedEvent = z.object({
  event: z.literal("started"),
  id: z.string(),
  childId: z.string(),
  harness: z.enum(["codex", "claude"]),
  text: z.string(),
});
const answerEvent = z.object({ event: z.literal("answer"), childId: z.string(), answer: z.unknown() });
const cancelledEvent = z.object({ event: z.literal("cancelled"), childId: z.string(), error: z.string() });
const exitedEvent = z.object({ event: z.literal("exited"), childId: z.string() });
const mailEvent = z.object({ event: z.literal("mail"), id: z.string(), text: z.string() });
export const hostEventSchema = z.discriminatedUnion("event", [
  readyEvent,
  startedEvent,
  answerEvent,
  cancelledEvent,
  exitedEvent,
  mailEvent,
]);
export const hostReplySchema = z
  .object({
    id: z.number().optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();
export const hostPacketSchema = z.union([hostEventSchema, hostReplySchema]);
export const hostRequestSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
  args: dataSchema.default({}),
});

export type HostEvent = z.infer<typeof hostEventSchema>;
export type HostReply = z.infer<typeof hostReplySchema>;
export type HostPacket = z.infer<typeof hostPacketSchema>;
