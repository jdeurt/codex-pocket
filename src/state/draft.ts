import { z } from "zod";

export const draftDataSchema = z.object({ text: z.string() });

export type DraftData = z.infer<typeof draftDataSchema>;
export interface DraftState extends DraftData {
  revision: number;
}

/** Create empty draft data without accessing storage.
@returns Initial draft revision.
*/
export function draftState(): DraftState {
  return { text: "", revision: 0 };
}

/** Apply a user edit without performing persistence.
@param state - Previous draft revision.
@param text - New user input.
@returns The next revision, leaving its input unchanged.
*/
export function editedDraft(state: DraftState, text: string): DraftState {
  return { text, revision: state.revision + 1 };
}

/** Select the durable subset, excluding lifecycle bookkeeping.
@param state - Current draft data.
@returns Plain text persistence payload.
*/
export function draftData(state: DraftState): DraftData {
  return { text: state.text };
}

/** Restore saved text only if the user has not edited since the read began.
@param saved - Untrusted persisted data.
@param current - Latest live revision.
@param hydrationRevision - Revision observed when hydration began.
@returns Current state with safe saved text, or the user's newer edit.
*/
export function restoredDraft(saved: unknown, current: DraftState, hydrationRevision: number): DraftState {
  return saved === undefined || current.revision !== hydrationRevision
    ? current
    : { ...current, text: draftDataSchema.parse(saved).text };
}

/** Select draft text for render subscriptions.
@param state - Current draft projection.
@returns User-entered text.
*/
export function draftText(state: DraftState) {
  return state.text;
}
