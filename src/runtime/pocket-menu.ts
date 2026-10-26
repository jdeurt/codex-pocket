import { type PocketEdit } from "../state/pockets";
import { type PocketMenuAction } from "../state/pocket-menu";
import { type PocketsController } from "../services/pockets";

type Dispatch = (action: PocketMenuAction) => void;

/** Allocate an idempotency identity when starting a new local editor.
@param dispatch - Local menu reducer.
*/
export function createPocketEdit(dispatch: Dispatch) {
  dispatch({ type: "edit", edit: { action: "create", id: crypto.randomUUID(), name: "" } });
}

/** Publish one edited name to the local reducer.
@param dispatch - Local menu reducer.
@param name - Native input value.
*/
export function renamePocketEdit(dispatch: Dispatch, name: string) {
  dispatch({ type: "name", name });
}

/** Select an existing catalog edit.
@param dispatch - Local menu reducer.
@param edit - Explicit catalog edit.
*/
export function selectPocketEdit(dispatch: Dispatch, edit: PocketEdit) {
  dispatch({ type: "edit", edit });
}

/** Close the editor and clear its operation error.
@param pockets - Catalog operation owner.
@param dispatch - Local menu reducer.
*/
export function cancelPocketEdit(pockets: PocketsController, dispatch: Dispatch) {
  dispatch({ type: "edit", edit: null });
  pockets.clearError();
}

/** Persist the selected edit while the operation owner records failures.
@param pockets - Catalog operation owner.
@param dispatch - Local menu reducer.
@param edit - Current edit, if any.
@param isBusy - Combined settings and catalog lock.
*/
export async function savePocketEdit(
  pockets: PocketsController,
  dispatch: Dispatch,
  edit: PocketEdit | null,
  isBusy: boolean
) {
  if (!edit || isBusy) {
    return;
  }

  const result = await pockets.save(edit);

  if (result.ok) {
    dispatch({ type: "edit", edit: null });
  }
}

/** Apply native modal navigation only when no persistence operation is active.
@param pockets - Catalog operation owner.
@param dispatch - Local menu reducer.
@param publishOpen - Parent's covered-transcript setter.
@param isBusy - Combined settings and catalog lock.
@param isOpen - Native modal target state.
@param details - Native cancellation control.
*/
export function openPocketMenu(
  pockets: PocketsController,
  dispatch: Dispatch,
  publishOpen: (isOpen: boolean) => void,
  isBusy: boolean,
  isOpen: boolean,
  details?: { cancel: () => void }
) {
  if (isBusy) {
    details?.cancel();

    return;
  }

  dispatch({ type: "open", isOpen });
  publishOpen(isOpen);
  pockets.clearError();
}
