import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiCosts } from "./cost-tracking";

/** Reconcile summary accounting after Pi appends compaction or branch records outside ordinary turns.
@param parentId - Application-owned parent.
@param _event - Native extension notification; accounting comes from its immutable source.
@param context - Pi-owned source reader, with no additional model request.
*/
function synchronizeCostSource(parentId: string, _event: unknown, context: ExtensionContext) {
  new PiCosts(parentId).sync(context.sessionManager.getEntries());
}

/** Observe native context-management accounting independently from membership and compaction policy.
@param parentId - Trusted parent identity.
@param api - Native Pi extension boundary.
*/
export function costAccountingExtension(parentId: string, api: ExtensionAPI) {
  api.on("session_compact", synchronizeCostSource.bind(undefined, parentId));
  api.on("session_tree", synchronizeCostSource.bind(undefined, parentId));
}
