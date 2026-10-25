import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Ledger } from "./model";
import { recordEvent } from "./transitions";
import { updateTasks } from "./repository";
import { piTaskEvent } from "./adapters/pi";
import { reconcileRoutes } from "./reconciliation";

/** Check a previously committed binding identity.
@param nativeEntryId - Native source identity.
@param binding - Durable binding.
@returns Identity equality.
*/
function hasNativeBinding(nativeEntryId: string, binding: Ledger["bindings"][number]) {
  return binding.nativeEntryId === nativeEntryId;
}

/** Apply exact native correlation and ingestion cursor in one pure transition.
@param entries - Native originals, used only for recorded causal identities.
@param entry - Committed native source.
@param sourceFile - Immutable original reference.
@param state - Current checkpoint.
@returns Reconciled checkpoint without replaying any native work.
*/
function nativeTransition(entries: readonly SessionEntry[], entry: SessionEntry, sourceFile: string, state: Ledger) {
  const event = piTaskEvent(state, entries, entry, sourceFile);

  let next = event ? recordEvent(state, event) : state;

  if (event?.receiptId && event.nativeEntryId) {
    const isExists = next.bindings.some(hasNativeBinding.bind(undefined, event.nativeEntryId));

    if (!isExists) {
      next = {
        ...next,
        bindings: [...next.bindings, { nativeEntryId: event.nativeEntryId, receiptId: event.receiptId }],
      };
    }
  }

  return reconcileRoutes({ ...next, cursor: entry.id });
}

/** Persist native provenance and memberships independently of the legacy archive.
@param parentId - Owning parent.
@param entries - Exact native records.
@param entry - New committed source.
@param sourceFile - Exact immutable source reference.
@returns Committed ledger checkpoint.
*/
export function ingestNativeTaskEvent(
  parentId: string,
  entries: readonly SessionEntry[],
  entry: SessionEntry,
  sourceFile: string
) {
  return updateTasks(
    parentId,
    "Ingest native provenance and reconcile pending relationships",
    nativeTransition.bind(undefined, entries, entry, sourceFile)
  );
}
