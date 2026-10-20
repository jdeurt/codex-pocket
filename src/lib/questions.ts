import { z } from "zod";

export const questionsSchema = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    isSecret: z.boolean().optional(),
    options: z
      .array(z.object({ label: z.string(), description: z.string().optional() }))
      .nullable()
      .optional(),
  })
);

export type Question = z.infer<typeof questionsSchema>[number];
