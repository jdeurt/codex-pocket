import { type Data } from "../lib/protocol";
import { type VoiceSegment } from "../lib/voice-history";
import { type VoiceSessionOwner } from "./voice-session-owner";
import { t } from "try";
import { createStore } from "zustand/vanilla";
import {
  realtimeToolState,
  receivedTools,
  requestedTools,
  resolvedTool,
  liveResultEvents,
  completedTools,
} from "../state/realtime-tools";
import { type voiceWorkerResult } from "../state/voice-context";
import { log } from "./logging";

export { REALTIME_TOOL_PREFIX } from "../state/realtime-tools";

/**
Own deduplicated GPT-Live client delegations and their existing main-agent outbox receipts.
*/
export class RealtimeTools {
  private readonly store = createStore(realtimeToolState);

  /** Bind this call's backend and native sideband, without owning its media.
  @param sessionId - Local call identity used for durable source receipts.
  @param owner - Main Pocket's authorized backend interface.
  @param send - Session-scoped GPT-Live command sender.
  @param fail - Original transport failure handler.
  @param historical - Startup context supplied once; not new authorization.
  */
  constructor(
    private sessionId: string,
    private owner: VoiceSessionOwner,
    private send: (event: Data) => void,
    private fail: (error: unknown) => void,
    private historical: string
  ) {}

  /** Send verified context immediately; GPT-Live continues its own conversational schedule.
  @param delegationId - Original provider delegation identity.
  @param text - Actual backend result or confirmed failure description.
  */
  private result(delegationId: string | null, text: string) {
    if (!this.store.getState().active) {
      return;
    }

    for (const event of liveResultEvents(delegationId, text, crypto.randomUUID())) {
      const sent = t(this.send, event);

      if (!sent.ok) {
        this.fail(sent.error);

        return;
      }
    }
  }

  /** Dispatch an already reserved receipt without waiting for caption persistence or silence.
  @param call - Pure handoff description derived from observed user context.
  */
  private async dispatch(call: Parameters<VoiceSessionOwner["handoff"]>[0]) {
    const delivery = await t(this.owner.handoff.bind(this.owner), call);
    const current = this.store.getState();
    const delegationId = current.pending.get(call.id);

    if (!delegationId || (delivery.ok && ["sent", "queued"].includes(delivery.value.status))) {
      return;
    }

    this.store.setState(resolvedTool(current, call.id), true);

    if (!delivery.ok) {
      log().error({ error: delivery.error, id: call.id }, "live.delegation_failed");
    }

    this.result(
      delegationId,
      "The requested work could not be confirmed. Do not automatically retry or claim completion."
    );
  }

  /** Reserve provider metadata, then dispatch only after current user speech has been observed.
  @param event - Native Live event.
  @param fragments - Already observed captions; no storage barrier.
  */
  receive(event: Data, fragments: VoiceSegment[]) {
    const observed = receivedTools(this.store.getState(), event);
    const requested = requestedTools(observed, this.sessionId, fragments, this.historical);

    this.store.setState(requested.state, true);

    for (const call of requested.calls) {
      void this.dispatch(call);
    }
  }

  /** Return each verified parent turn once, including later delegate-report continuations.
  @param result - Main Pocket's own result and canonical input identities.
  */
  completed(result: NonNullable<ReturnType<typeof voiceWorkerResult>>) {
    const next = completedTools(this.store.getState(), result);

    this.store.setState(next.state, true);

    for (const update of next.updates) {
      this.result(update.delegationId, update.text);
    }
  }

  /**
  Revoke future result destinations without cancelling accepted main-agent work.
  */
  close() {
    this.store.setState({ active: false, waiting: new Map(), pending: new Map() });
  }
}
