import { type PocketEdit } from "./pockets";

export interface PocketMenuState {
  isOpen: boolean;
  isSettingsOpen: boolean;
  edit: PocketEdit | null;
}
export type PocketMenuAction =
  | { type: "open"; isOpen: boolean }
  | { type: "settings"; isOpen: boolean }
  | { type: "edit"; edit: PocketEdit | null }
  | { type: "name"; name: string };
export const initialPocketMenu: PocketMenuState = { isOpen: false, isSettingsOpen: false, edit: null };

/** Transition menu presentation without changing catalog or browser state.
@param state - Current local menu state.
@param action - Explicit navigation or editor intent.
@returns Next menu state.
*/
export function pocketMenuChanged(state: PocketMenuState, action: PocketMenuAction): PocketMenuState {
  switch (action.type) {
    case "open": {
      return { ...initialPocketMenu, isOpen: action.isOpen };
    }

    case "settings": {
      return { ...state, isSettingsOpen: action.isOpen };
    }

    case "edit": {
      return { ...state, edit: action.edit };
    }

    case "name": {
      return state.edit ? { ...state, edit: { ...state.edit, name: action.name } } : state;
    }
  }
}

/** Enable catalog dismissal only when no editor or persistence operation is active.
@param state - Local menu section and editor.
@param isOpen - Controlled modal visibility.
@param isBusy - Combined persistence lock.
@returns Whether a swipe can return to the selected Pocket.
*/
export function canSwipePocketList(state: PocketMenuState, isOpen: boolean, isBusy: boolean) {
  return isOpen && !state.isSettingsOpen && !state.edit && !isBusy;
}
