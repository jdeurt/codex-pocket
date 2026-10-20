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

/** Read the explicit per-tab selection without sharing mutable browser cookies.
@returns The selected Pocket identity, or the configured original Pocket.
*/
export function selectedPocketId() {
  return typeof location === "undefined" ? "main" : (new URLSearchParams(location.search).get("pocket") ?? "main");
}

/** Retain the selected Pocket on a same-origin API or viewer link.
@param path - Internal route whose existing query must be preserved.
@returns The explicitly scoped route for this browser tab.
*/
export function pocketUrl(path: string) {
  const id = selectedPocketId();

  return id === "main" || /[?&]pocket=/.test(path)
    ? path
    : `${path}${path.includes("?") ? "&" : "?"}pocket=${encodeURIComponent(id)}`;
}

/** Build a full navigation that isolates stream, delivery, and draft owners.
@param id - Saved Pocket identity selected by the user.
@returns The parent chat route for this Pocket.
*/
export const pocketHref = (id: string) => (id === "main" ? "/" : `/?pocket=${encodeURIComponent(id)}`);
