import { z } from "zod";

const questionOptionSchema = z.object({ label: z.string(), description: z.string().optional() });
const questionSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  isSecret: z.boolean().optional(),
  options: z.array(questionOptionSchema).nullable().optional(),
});
export const questionsSchema = z.array(questionSchema);

export type Question = z.infer<typeof questionsSchema>[number];
