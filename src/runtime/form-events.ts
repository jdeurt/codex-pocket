import { type ChangeEvent, type MouseEvent, type RefObject, type SubmitEvent } from "react";
import { type PocketSettingsMutation } from "../lib/settings";

/** Publish an input value through its explicit component-local setter.
@param publish - Setter owned by the rendered form.
@param event - Native text input change.
*/
export function updateInput(
  publish: (text: string) => void,
  event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
) {
  publish(event.target.value);
}

/** Retain exactly the DOM node associated with one list identity.
@param rows - Runtime focus-handle registry.
@param id - Stable list identity.
@param node - Mounted element, or null on removal.
*/
export function retainButton(
  rows: RefObject<Map<string, HTMLButtonElement>>,
  id: string,
  node: HTMLButtonElement | null
) {
  if (node) {
    rows.current.set(id, node);
  } else {
    rows.current.delete(id);
  }
}

/** Open an agent while retaining the triggering control for focus restoration.
@param open - Owning navigation action.
@param agentId - Explicit agent identity.
@param event - Native activation event.
*/
export function openAgentFromButton(
  open: (id: string, trigger: HTMLButtonElement) => void,
  agentId: string,
  event: MouseEvent<HTMLButtonElement>
) {
  open(agentId, event.currentTarget);
}

/** Submit explicit realtime fields through the service that owns persistence and errors.
@param save - Owning settings operation.
@param voice - Current local voice field.
@param model - Current local model field.
@param event - Native form submission.
*/
export function submitRealtimeSettings(
  save: (change: PocketSettingsMutation) => Promise<unknown>,
  voice: string,
  model: string,
  event: SubmitEvent<HTMLFormElement>
) {
  event.preventDefault();
  void save({ realtimeVoice: voice.trim() || null, realtimeModel: model.trim() || null });
}

/** Focus an input-group's field without intercepting nested button activation.
@param event - Native addon click.
*/
export function focusInputGroup(event: MouseEvent<HTMLDivElement>) {
  if (!(event.target instanceof Element && event.target.closest("button"))) {
    event.currentTarget.parentElement?.querySelector("input")?.focus();
  }
}

/** Focus a mounted local control after its view changes.
@param element - Mounted control reference.
*/
export function focusControl(element: RefObject<HTMLElement | null>) {
  element.current?.focus();
}

/** Submit a form through the asynchronous operation that owns its errors.
@param submit - Explicit owning operation.
@param event - Native form submission.
*/
export function submitOperation(submit: () => Promise<void>, event: SubmitEvent<HTMLFormElement>) {
  event.preventDefault();
  void submit();
}
