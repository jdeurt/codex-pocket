/* eslint-disable @typescript-eslint/no-magic-numbers -- PCM16 bounds match native realtime v2. */
import { object } from "../lib/protocol";
import { z } from "zod";

export interface RealtimeMessage {
  type: string;
  role?: string;
  text?: string;
  audio?: z.infer<typeof audioSchema>;
  error?: string;
}

export const audioSchema = z
  .object({
    data: z
      .string()
      .min(1)
      .max(48_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    sampleRate: z.literal(24_000),
    numChannels: z.literal(1),
    samplesPerChannel: z.number().int().positive().max(12_000),
  })
  .strict();
export const settingsSchema = z
  .object({ voice: z.string().min(1).optional(), model: z.string().trim().min(1).max(120).nullable().optional() })
  .strict();
const voicesSchema = z.object({ v2: z.array(z.string()), defaultV2: z.string() }).loose();
export const voiceListSchema = z.object({ voices: voicesSchema });

/**
Validate native output before forwarding binary audio to a browser.
@param value - Untrusted native audio value.
@returns PCM16 audio with verified dimensions, or undefined.
*/
export function parseOutputAudio(value: unknown) {
  const audio = object(value);

  if (audio.sampleRate !== 24_000 || audio.numChannels !== 1 || typeof audio.data !== "string") {
    return;
  }

  const parsed = audioSchema.safeParse({
    data: audio.data,
    sampleRate: 24_000,
    numChannels: 1,
    samplesPerChannel: Buffer.from(audio.data, "base64").byteLength / 2,
  });

  return parsed.success ? parsed.data : undefined;
}
