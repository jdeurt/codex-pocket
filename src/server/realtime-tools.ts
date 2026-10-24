import { type Data } from "../lib/protocol";
import type { VoiceSessionOwner } from "./voice-session-owner";
import { t } from "try";
import { createStore } from "zustand/vanilla";
import {
  realtimeToolState,
  completedToolResponse,
  receivedTools,
  requestedTool,
  queuedToolResult,
  resolvedTool,
  flushedTools,
} from "../state/realtime-tools";
import { log } from "./logging";

export { REALTIME_TOOL_PREFIX } from "../state/realtime-tools";

/**
Execute worker handoffs and provider controls independently of media and transcript storage.
*/
export class RealtimeTools {
  private readonly store = createStore(realtimeToolState);

  /** Bind one live conversation's worker and provider controls.
  @param sessionId - Unique voice connection identity.
  @param owner - Main-agent delivery interface.
  @param send - Server control channel, never microphone audio.
  @param fail - Owning session's control failure handler.
  */
  constructor(
    private sessionId: string,
    private owner: VoiceSessionOwner,
    private send: (event: Data) => void,
    private fail: (error: unknown) => void
  ) {}

  /**
  Send selected control frames and surface the exact transport failure.
  */
  private flush() {
    const flushed = flushedTools(this.store.getState());

    this.store.setState(flushed.state, true);

    for (const event of flushed.events) {
      const sent = t(this.send, event);

      if (!sent.ok) {
        this.fail(sent.error);

        return;
      }
    }
  }

  /** Queue an actual outcome in its original live conversation.
  @param callId - Provider call awaiting the result.
  @param result - Worker outcome or explicit delivery uncertainty.
  */
  private result(callId: string, result: Data) {
    this.store.setState(queuedToolResult(this.store.getState(), callId, result), true);
    this.flush();
  }

  /** Dispatch a deduplicated request without consulting captions or waiting for storage.
  @param call - Provider's completed native function call.
  */
  private async dispatch(call: Data) {
    const requested = requestedTool(this.store.getState(), this.sessionId, call);

    this.store.setState(requested.state, true);

    if (!requested.callId) {
      return;
    }

    if (!requested.id) {
      this.result(requested.callId, { error: requested.error });

      return;
    }

    const delivery = await t(this.owner.handoff.bind(this.owner), {
      id: requested.id,
      request: requested.request,
      source: { type: "realtime", sessionId: this.sessionId, itemId: requested.callId },
    });
    const current = this.store.getState();

    if (!delivery.ok) {
      log().error(
        { error: delivery.error, sessionId: this.sessionId, callId: requested.callId },
        "realtime.handoff_failed"
      );
      this.store.setState(resolvedTool(current, requested.id), true);
      this.result(requested.callId, {
        status: "unknown",
        error: "Work could not be confirmed. Do not automatically retry.",
      });

      return;
    }

    if (!current.pending.has(requested.id) || delivery.value.status === "sent" || delivery.value.status === "queued") {
      return;
    }

    this.store.setState(resolvedTool(current, requested.id), true);
    this.result(requested.callId, {
      status: "unknown",
      error: "Delivery is uncertain. Check the work before retrying.",
    });
  }

  /** Publish immutable provider state before launching selected worker requests.
  @param event - Provider control event.
  */
  receive(event: Data) {
    const received = receivedTools(this.store.getState(), event);

    this.store.setState(received.state, true);

    for (const call of received.calls) {
      void this.dispatch(call);
    }

    if (!received.isCompleted) {
      return;
    }

    this.store.setState(completedToolResponse(this.store.getState()), true);
    this.flush();
  }

  /** Resolve a worker receipt back to its original provider call.
  @param id - Main-agent delivery identity.
  @param text - Actual worker answer.
  @param status - Native turn completion status.
  */
  answer(id: string, text: string, status = "completed") {
    const current = this.store.getState();
    const callId = current.pending.get(id);

    if (!callId) {
      return;
    }

    this.store.setState(resolvedTool(current, id), true);
    this.result(callId, { status, result: text || "The worker finished without a text result." });
  }

  /**
  Detach pending work without replaying it into a future voice connection.
  */
  close() {
    this.store.setState({ active: false, pending: new Map(), results: [] });
  }
}
