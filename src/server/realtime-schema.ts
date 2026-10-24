import { z } from "zod";

const MAX_MODEL_LENGTH = 120;

export const settingsSchema = z
  .object({
    voice: z.string().min(1).optional(),
    model: z.string().trim().min(1).max(MAX_MODEL_LENGTH).nullable().optional(),
  })
  .strict();
