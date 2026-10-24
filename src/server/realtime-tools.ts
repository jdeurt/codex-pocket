import { type Data, object, string } from "../lib/protocol";
import { type VoiceSessionOwner } from "./voice-session-owner";
import { z } from "zod";
import { t as attempt } from "try";

const MAX_REQUEST_LENGTH = 32_000;
const argumentsSchema = z.object({ request: z.string().trim().min(1).max(MAX_REQUEST_LENGTH) }).strict();
export const REALTIME_TOOL_PREFIX = "realtime-tool:";

/**
Run worker requests independently of media and transcript storage.
*/
export class RealtimeTools {
  private completed = new Set<string>();
  private finishedResponses = new Set<string>();
  private responseId?: string;
  private pending = new Map<string, string>();
  private results: Data[] = [];
  private responseActive = false;
  private speaking = false;
  private awaitingSpeechResponse = false;
  private active = true;

  /** Bind a single live conversation's worker and provider controls.
  @param sessionId - Unique identity for this voice connection.
  @param owner - Main-agent delivery interface.
  @param send - Server control channel; never carries microphone audio.
  @param fail - Report control delivery failures to the owning session.
  */
  constructor(
    private sessionId: string,
    private owner: VoiceSessionOwner,
    private send: (event: Data) => void,
    private fail: (error: unknown) => void
  ) {}

  /**
  Return completed tools when the user and provider have finished their current speech.
  */
  private flush() {
    if (
      !this.active ||
      this.responseActive ||
      this.speaking ||
      this.awaitingSpeechResponse ||
      this.results.length === 0
    ) {
      return;
    }

    const outcome = attempt(() => {
      this.sendResults();
    });

    if (outcome.ok) {
      return;
    }

    const error = outcome.error;

    this.fail(error);
  }

  /**
  Append tool outputs to this conversation and request its next spoken response.
  */
  private sendResults() {
    for (const result of this.results.splice(0)) {
      this.send(result);
    }

    this.responseActive = true;
    this.send({ type: "response.create" });
  }

  /** Queue an actual tool result in the existing audio conversation.
  @param callId - Provider function call awaiting this result.
  @param result - Worker result or explicit dispatch failure.
  */
  private result(callId: string, result: Data) {
    if (!this.active) {
      return;
    }

    this.results.push({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    });
    this.flush();
  }

  /** Dispatch the voice agent's request once, without consulting its transcription.
  @param call - A completed provider function call.
  */
  private async dispatch(call: Data) {
    const callId = string(call.call_id);

    if (!callId || this.completed.has(callId)) {
      return;
    }

    this.completed.add(callId);

    if (call.name !== "handoff_to_pocket") {
      this.result(callId, { error: "That tool is unavailable. No work was dispatched." });

      return;
    }

    const decoded = attempt(JSON.parse, string(call.arguments));
    const input = argumentsSchema.safeParse(decoded.ok ? decoded.value : undefined);

    if (!input.success) {
      this.result(callId, { error: "Supply a nonempty request describing the work to do." });

      return;
    }

    const id = `${REALTIME_TOOL_PREFIX}${this.sessionId}:${callId}`;

    this.pending.set(id, callId);

    const delivery = await attempt(() =>
      this.owner.handoff({
        id,
        request: input.data.request,
        source: { type: "realtime", sessionId: this.sessionId, itemId: callId },
      })
    );

    if (!delivery.ok) {
      this.pending.delete(id);
      this.result(callId, { status: "unknown", error: "Work could not be confirmed. Do not automatically retry." });

      return;
    }

    const result = delivery.value;

    if (!this.pending.has(id) || result.status === "sent" || result.status === "queued") {
      return;
    }

    this.pending.delete(id);
    this.result(callId, { status: "unknown", error: "Delivery is uncertain. Check the work before retrying." });
  }

  /** Track provider activity and accept tools only from completed responses.
  @param event - Provider control event, processed immediately rather than behind persistence.
  */
  receive(event: Data) {
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        this.speaking = true;
        this.awaitingSpeechResponse = true;
        break;
      }

      case "input_audio_buffer.speech_stopped": {
        this.speaking = false;
        break;
      }

      case "response.created": {
        this.responseId = string(object(event.response).id);
        this.responseActive = true;
        this.awaitingSpeechResponse = false;
        break;
      }

      case "response.done": {
        const response = object(event.response);
        const id = string(response.id);

        if (this.finishedResponses.has(id) || (this.responseId && this.responseId !== id)) {
          return;
        }

        this.finishedResponses.add(id);

        if (response.status === "completed" && Array.isArray(response.output)) {
          for (const value of response.output) {
            const call = object(value);

            if (call.type === "function_call") {
              void this.dispatch(call);
            }
          }
        }

        this.responseActive = false;
        this.responseId = undefined;
        this.flush();
        break;
      }
    }
  }

  /** Resolve worker receipts back to their original provider function call.
  @param id - Main-agent delivery receipt.
  @param text - Actual worker answer.
  @param status - Native turn completion status.
  */
  answer(id: string, text: string, status = "completed") {
    const callId = this.pending.get(id);

    if (!callId) {
      return;
    }

    this.pending.delete(id);
    this.result(callId, { status, result: text || "The worker finished without a text result." });
  }

  /**
  Detach pending work from this connection; never replay it into a later voice session.
  */
  close() {
    this.active = false;
    this.pending.clear();
    this.results = [];
  }
}
