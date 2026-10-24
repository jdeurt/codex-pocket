import { z } from "zod";

export const voiceSegmentSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  done: z.boolean(),
  nativeSessionId: z.string(),
  afterItemId: z.string().nullable().optional(),
  groupId: z.string().optional(),
  startMs: z.number().nonnegative().optional(),
  endMs: z.number().nonnegative().optional(),
  handoffId: z.string().optional(),
  handoff: z.enum(["sending", "queued", "sent", "unknown"]).optional(),
});
export const voiceHistorySchema = z.array(voiceSegmentSchema);

export type VoiceSegment = z.infer<typeof voiceSegmentSchema>;

export interface VoiceHandoff {
  id: string;
  request: string;
  source: { type: "realtime"; sessionId: string; itemId: string };
}
