import { type ThreadStore, stageMessage, updateDelivery } from "../state/thread";
import { type VoiceStore } from "../state/voice";
import { createOperationStore } from "../state/resource";
import { type createDraftController } from "./draft";
import { type createAttachmentController } from "./attachments";
import { post } from "../lib/client-api";
import { clientError, reportClient } from "../lib/client-logging";

/** Own composer delivery and retries outside rendering, preserving the durable client identity.
@param thread - Canonical and optimistic conversation projection.
@param voice - Voice lifecycle used to enforce text/voice exclusivity.
@param draft - Persisted text owner.
@param attachments - Original-file upload owner.
@param url - Selected Pocket's message endpoint.
@returns Observable mutation state and stable submit/reset operations.
*/
export function createDeliveryController(
  thread: ThreadStore,
  voice: VoiceStore,
  draft: ReturnType<typeof createDraftController>,
  attachments: ReturnType<typeof createAttachmentController>,
  url: string
) {
  const store = createOperationStore();

  let messageId: string | null = null;

  const didSend = async () => {
    const current = thread.getState();
    const files = attachments.store.getState();
    const text = draft.store.getState().text.trim();

    if (
      store.getState().busy ||
      voice.getState().state !== "idle" ||
      !current.connected ||
      current.state.connection !== "connected" ||
      !files.ready ||
      (!text && files.draft.files.length === 0) ||
      files.draft.files.some((entry) => !entry.uploaded)
    ) {
      return false;
    }

    const uploaded = files.draft.files.flatMap((entry) => entry.uploaded ?? []);
    const id = (messageId ??= files.draft.pending?.text === text ? files.draft.pending.id : crypto.randomUUID());

    store.setState({ busy: true, error: "", status: "" });
    reportClient("message.send", { id, text, activeTurnId: current.state.activeTurnId });
    const submit = async () => {
      await attachments.rememberSend(id, text);
      stageMessage(thread, id, text, uploaded);
      draft.setText("");
      const result = await post(url, { id, text, attachments: uploaded.map((file) => file.id) });

      if (result.status === "unknown") {
        throw new Error("Delivery is uncertain. Check the conversation on your computer before sending again.");
      }

      updateDelivery(thread, id, result.status === "sent" ? "sent" : "queued");
      reportClient("message.acknowledged", { id, status: result.status });
      await attachments.clear();
      messageId = null;
    };

    return (async () => {
      await submit();

      return true;
    })()
      .catch((error: unknown) => {
        reportClient("message.failed", { id, ...clientError(error) }, "error");
        updateDelivery(thread, id, "unknown");
        draft.setText(text);
        store.setState({ error: error instanceof Error ? error.message : "Couldn't send. Try again when connected." });

        return false;
      })
      .finally(() => {
        store.setState({ busy: false });
      });
  };

  return {
    store,
    send: didSend,
    reset: () => {
      messageId = null;
    },
  };
}
