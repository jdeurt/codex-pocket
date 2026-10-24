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

/** Require another ready conversation before deleting the last usable Pocket.
@param entries - Current durable catalog.
@param selected - Entry whose native work has already been checked.
*/
export function requireRemovablePocket(entries: readonly Pocket[], selected: Pocket) {
  if (selected.state !== "ready") {
    return;
  }

  for (const entry of entries) {
    if (entry.id !== selected.id && entry.state === "ready") {
      return;
    }
  }

  throw new Error("Create another Pocket before deleting the last one.");
}

/** Resolve the catalog entry belonging to an explicit native owner.
@param entries - Saved named Pockets.
@param threadId - Verified native owner identity.
@returns Matching catalog entry, if it exists.
*/
export function pocketForThread(entries: readonly Pocket[], threadId: string) {
  for (const entry of entries) {
    if (entry.threadId === threadId) {
      return entry;
    }
  }
}
