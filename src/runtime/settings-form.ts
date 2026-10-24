import { type ChangeEvent, type SubmitEvent } from "react";
import { type PocketSettingsMutation } from "../lib/settings";

type Save = (change: PocketSettingsMutation) => Promise<boolean>;

/** Persist an optimistic checkbox and restore it when the settings owner reports failure.
@param didSave - Settings operation that publishes its own error.
@param publish - Local checkbox setter.
@param isChecked - Requested value.
*/
async function persistToolVisibility(didSave: Save, publish: (isChecked: boolean) => void, isChecked: boolean) {
  publish(isChecked);

  if (!(await didSave({ showToolCalls: isChecked }))) {
    publish(!isChecked);
  }
}

/** Forward a native checkbox event to the settings operation.
@param didSave - Settings operation.
@param publish - Local checkbox setter.
@param event - Native input event.
*/
export function changeToolVisibility(
  didSave: Save,
  publish: (isChecked: boolean) => void,
  event: ChangeEvent<HTMLInputElement>
) {
  void persistToolVisibility(didSave, publish, event.target.checked);
}

/** Clear the write-only field only after the settings owner confirms persistence.
@param didSave - Settings operation that owns error publication.
@param publish - Local credential field setter.
@param value - New credential or explicit removal.
*/
async function persistKey(didSave: Save, publish: (value: string) => void, value: string | null) {
  if (await didSave({ openaiApiKey: value })) {
    publish("");
  }
}

/** Submit the current write-only credential through its owning operation.
@param didSave - Settings operation.
@param publish - Local credential field setter.
@param value - Current user input.
@param event - Native form submission.
*/
export function submitKey(
  didSave: Save,
  publish: (value: string) => void,
  value: string,
  event: SubmitEvent<HTMLFormElement>
) {
  event.preventDefault();
  void persistKey(didSave, publish, value.trim());
}

/** Remove the saved credential through its owning operation.
@param didSave - Settings operation.
@param publish - Local credential field setter.
*/
export function removeKey(didSave: Save, publish: (value: string) => void) {
  void persistKey(didSave, publish, null);
}
