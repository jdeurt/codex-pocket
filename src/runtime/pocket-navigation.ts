import { scopedPocketUrl } from "../state/pocket";

/** Read per-tab selection at the browser navigation boundary.
@returns Selected Pocket identity, defaulting to the original Pocket during SSR.
*/
export function selectedPocketId() {
  return typeof location === "undefined" ? "main" : (new URLSearchParams(location.search).get("pocket") ?? "main");
}

/** Scope a browser request using its current navigation state.
@param path - Internal route retaining its existing query.
@returns Route bound to this browser tab's selection.
*/
export function pocketUrl(path: string) {
  return scopedPocketUrl(selectedPocketId(), path);
}
