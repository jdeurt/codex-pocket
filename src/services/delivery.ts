import { operationState } from "../state/resource";
import { type ThreadStore, type VoiceStore, stageMessage, updateDelivery, observable } from "../runtime/stores";
import { t } from "try";
import { type DraftController } from "./draft";
import { type AttachmentController } from "./attachments";
import { post } from "../runtime/client-api";
import { clientError, reportClient } from "../runtime/client-logging";
import { attachmentId, messageInput, type MessageInput } from "../state/delivery";

type Draft = DraftController;
type Attachments = AttachmentController;

/**
Runtime owner of composer delivery, durable receipts and retry identity.
*/
export class DeliveryController {
  private messageId: string | null = null;

  /** Persist the send receipt before publishing or submitting the message.
  @param id - Durable idempotency identity.
  @param input - Purely prepared send input.
  */
  private submit = async (id: string, input: MessageInput) => {
    await this.attachments.rememberSend(id, input.text);
    stageMessage(this.thread, id, input.text, input.attachments);
    this.draft.setText("");
    const result = await post(this.url, {
      id,
      text: input.text,
      attachments: Array.from(input.attachments, attachmentId),
    });

    if (result.status === "unknown") {
      throw new Error("Delivery is uncertain. Check the conversation on your computer before sending again.");
    }

    updateDelivery(this.thread, id, result.status === "sent" ? "sent" : "queued");
    reportClient("message.acknowledged", { id, status: result.status });
    await this.attachments.clear();
    this.messageId = null;
  };

  readonly store = observable(operationState());

  /** Perform the prepared send and recover its original text after a failure.
  @returns Whether the server acknowledged this delivery.
  */
  send = async () => {
    const current = this.thread.getState();
    const input = messageInput(
      current,
      this.voice.getState().state,
      this.attachments.store.getState(),
      this.draft.store.getState().text,
      this.store.getState().busy
    );

    if (!input) {
      return false;
    }

    const id = (this.messageId ??= input.receiptId ?? crypto.randomUUID());

    this.store.setState({ busy: true, error: "", status: "" });
    reportClient("message.send", { id, text: input.text, activeTurnId: current.state.activeTurnId });
    const delivered = await t(this.submit, id, input);

    this.store.setState({ busy: false });

    if (!delivered.ok) {
      const error = delivered.error;

      reportClient("message.failed", { id, ...clientError(error) }, "error");
      updateDelivery(this.thread, id, "unknown");
      this.draft.setText(input.text);
      this.store.setState({
        error: error instanceof Error ? error.message : "Couldn't send. Try again when connected.",
      });
    }

    return delivered.ok;
  };

  /**
  Clear a prior retry identity after the user changes their input.
  */
  reset = () => {
    this.messageId = null;
  };

  /** Bind effectful collaborators without starting work.
  @param thread - Conversation runtime.
  @param voice - Voice lifecycle runtime.
  @param draft - Durable text owner.
  @param attachments - Original-file owner.
  @param url - Scoped message endpoint.
  */
  constructor(
    private readonly thread: ThreadStore,
    private readonly voice: VoiceStore,
    private readonly draft: Draft,
    private readonly attachments: Attachments,
    private readonly url: string
  ) {}
}
