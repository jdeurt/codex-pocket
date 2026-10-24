import { type ChangeEvent, type KeyboardEvent, type RefObject, type SubmitEvent } from "react";
import { type PocketClient } from "../services/pocket-client";

/** Open an agent and retain the actual trigger for focus restoration.
@param focus - Navigation's native focus reference.
@param select - Local selection setter.
@param open - Local panel setter.
@param id - Selected agent.
@param trigger - Activated native button.
*/
export function openChatAgent(
  focus: RefObject<HTMLElement | null>,
  select: (id: string) => void,
  open: (isOpen: boolean) => void,
  id: string,
  trigger: HTMLButtonElement
) {
  focus.current = trigger;
  select(id);
  open(true);
}

/** Combine local navigation and service-owned durability before applying updates.
@param client - Scoped service root.
@param isMenuOpen - Whether navigation is covering the conversation.
@returns Whether a reload preserves ongoing work.
*/
export function canReloadChat(client: PocketClient, isMenuOpen: boolean) {
  return !isMenuOpen && client.canReload();
}

/** Send through the delivery owner and restore native composer focus on success.
@param client - Scoped service root.
@param textarea - Mounted composer field.
*/
async function sendMessage(client: PocketClient, textarea: RefObject<HTMLTextAreaElement | null>) {
  if (await client.delivery.send()) {
    textarea.current?.focus();
  }
}

/** Handle a native send action; delivery owns progress and error publication.
@param client - Scoped service root.
@param textarea - Mounted composer field.
*/
export function requestMessage(client: PocketClient, textarea: RefObject<HTMLTextAreaElement | null>) {
  void sendMessage(client, textarea);
}

/** Measure the composer before starting the service-owned media connection.
@param client - Scoped service root.
@param textarea - Mounted composer field.
@param publishHeight - Local layout setter.
*/
export function startChatVoice(
  client: PocketClient,
  textarea: RefObject<HTMLTextAreaElement | null>,
  publishHeight: (height: number | undefined) => void
) {
  publishHeight(textarea.current?.closest(".composer")?.getBoundingClientRect().height);
  void client.realtime.start();
}

/** Stop the service-owned media connection from a native control.
@param client - Scoped service root.
*/
export function stopChatVoice(client: PocketClient) {
  void client.realtime.stop();
}

/** Remove a durable attachment and clear the previous delivery error.
@param client - Scoped service root.
@param id - Attachment identity.
*/
export async function removeChatAttachment(client: PocketClient, id: string) {
  client.delivery.reset();
  await client.attachments.remove(id);
}

/** Submit text only when voice does not own the composer.
@param send - Explicit delivery action.
@param isVoiceActive - Whether live voice owns the composer.
@param event - Native form event.
*/
export function submitChat(send: () => void, isVoiceActive: boolean, event: SubmitEvent<HTMLFormElement>) {
  event.preventDefault();

  if (!isVoiceActive) {
    send();
  }
}

/** Hand native file selection to the durable attachment owner.
@param client - Scoped service root.
@param event - Native picker event.
*/
export function chooseChatAttachments(client: PocketClient, event: ChangeEvent<HTMLInputElement>) {
  const files = [...(event.target.files ?? [])];

  event.target.value = "";
  client.delivery.reset();
  void client.attachments.add(files);
}

/** Publish a draft edit and clear the previous delivery error.
@param client - Scoped service root.
@param event - Native composer input.
*/
export function editChatDraft(client: PocketClient, event: ChangeEvent<HTMLTextAreaElement>) {
  client.draft.setText(event.target.value);
  client.delivery.reset();
}

/** Apply desktop Enter submission while preserving composition and multiline input.
@param send - Explicit delivery action.
@param event - Native composer key event.
*/
export function chatKeyDown(send: () => void, event: KeyboardEvent<HTMLTextAreaElement>) {
  if (!(
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    globalThis.matchMedia("(pointer: fine)").matches
  )) {
    return;
  }

  event.preventDefault();
  send();
}

/** Open the mounted native attachment picker.
@param picker - Native file input reference.
*/
export function openFilePicker(picker: RefObject<HTMLInputElement | null>) {
  picker.current?.click();
}
