import { type Pocket } from "../lib/pockets";
import { findById } from "../lib/identity";

export interface PocketEdit {
  action: "create" | "rename" | "delete";
  id: string;
  name: string;
}

/** Decide navigation from the accepted catalog mutation, without changing browser location.
@param change - User-requested catalog mutation.
@param selectedId - Current Pocket identity.
@param entries - Validated post-mutation catalog.
@returns Destination identity when navigation is required, otherwise undefined.
*/
export function pocketDestination(change: PocketEdit, selectedId: string, entries: Pocket[]) {
  if (change.action === "create") {
    if (findById(entries, change.id)?.state !== "ready") {
      throw new Error("Setup did not finish. Delete this entry before trying a new Pocket.");
    }

    return change.id;
  }

  if (!(change.action === "delete" && change.id === selectedId)) {
    return;
  }

  for (const entry of entries) {
    if (entry.state === "ready") {
      return entry.id;
    }
  }

  return "main";
}

/** Select a surviving home after the original Pocket was explicitly deleted.
@param entries - Explicit saved catalog.
@returns Ready destination identity only when the original main Pocket is absent.
*/
export function homeDestination(entries: readonly Pocket[]) {
  let destination: string | undefined;

  for (const entry of entries) {
    if (entry.id === "main") {
      return;
    }

    if (destination === undefined && entry.state === "ready") {
      destination = entry.id;
    }
  }

  return destination;
}
