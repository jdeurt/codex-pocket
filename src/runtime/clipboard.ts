import { t } from "try";

export type CopyStatus = "idle" | "copying" | "copied" | "error";

/** Access the browser clipboard synchronously within the initiating user gesture.
@param text - Exact validated payload.
@returns Native completion or a permission/availability failure.
*/
function writeClipboard(text: string) {
  return navigator.clipboard.writeText(text);
}

/** Publish the clipboard operation's progress and explicit failure result.
@param text - Exact payload, without trimming or normalization.
@param publish - Owning component's status setter.
*/
async function copyToClipboard(text: string, publish: (status: CopyStatus) => void) {
  publish("copying");
  const copied = await t(writeClipboard, text);

  publish(copied.ok ? "copied" : "error");
}

/** Start clipboard work from a synchronous event callback while retaining user activation.
@param text - Exact payload.
@param publish - Owning component's status setter.
*/
export function requestClipboardCopy(text: string, publish: (status: CopyStatus) => void) {
  void copyToClipboard(text, publish);
}
