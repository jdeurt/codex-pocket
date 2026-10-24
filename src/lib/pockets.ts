import { z } from "zod";

export const POCKET_NAME_LIMIT = 80;
export const pocketNameSchema = z.string().trim().min(1, "Give this Pocket a name.").max(POCKET_NAME_LIMIT);
export const pocketSchema = z.object({
  id: z.string(),
  name: pocketNameSchema,
  threadId: z.string().nullable(),
  state: z.enum(["creating", "ready", "failed"]),
  preview: z.string(),
  status: z.string(),
});

export type Pocket = z.infer<typeof pocketSchema>;
export const pocketsSchema = z.object({ pockets: z.array(pocketSchema), selectedId: z.string().nullable() });

/** Build a full navigation that isolates stream, delivery, and draft owners.
@param id - Saved Pocket identity selected by the user.
@returns The parent chat route for this Pocket.
*/
export const pocketHref = (id: string) => (id === "main" ? "/" : `/?pocket=${encodeURIComponent(id)}`);
