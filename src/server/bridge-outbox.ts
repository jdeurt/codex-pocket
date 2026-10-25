import { acceptTaskReceipts } from "../tasks/ingestion";
import { type Receipt, persistReceipts, restoreReceipts } from "./outbox";
import { assertMessageContent, resolveUploads } from "./uploads";
import type { BridgeSnapshots } from "./bridge-snapshots";
import type { CodexRpc } from "./rpc";
import type { Config } from "./config";
import { deliverMessage } from "./delivery";
import { t } from "try";
import { findById } from "../lib/identity";
import { queuedReceipts, receiptStatus } from "../state/outbox";
import { recoveryReceipt } from "../state/recovery";
import { log } from "./logging";
import { mainVoiceContext } from "./voice-main-context";
import { type MessageSource } from "../lib/protocol";

/**
Own durable parent submissions and their ordered native delivery transitions.
*/
export class BridgeOutbox {
  entries: Receipt[] = [];

  /**
  Bind durable receipt updates to the owning canonical snapshot.
  @param snapshots - Canonical state and publication owner.
  @param pocketId - Optional saved main-Pocket namespace for durable receipts.
  */
  constructor(
    private snapshots: BridgeSnapshots,
    private pocketId?: string
  ) {}

  /**
  Persist a new receipt before attempting native delivery.
  @param config - Validated parent configuration.
  @param rpc - Connected native client.
  @param id - Durable message identity.
  @param text - User message text.
  @param attachmentIds - Managed upload identifiers in request order.
  @param source - Optional finalized voice provenance, never inferred from text.
  @returns The receipt's durable delivery status.
  */
  private async deliver(
    config: Config,
    rpc: CodexRpc,
    id: string,
    text: string,
    attachmentIds: string[],
    source?: MessageSource
  ) {
    const attachments = await resolveUploads(config.threadId, attachmentIds);
    const voiceContext = source ? undefined : await mainVoiceContext(config.threadId, this.entries);
    const receipt: Receipt = {
      id,
      text,
      source,
      voiceContext,
      ...(attachments.length > 0 && { attachments }),
      status: "queued",
    };

    this.entries = [...this.entries, receipt];
    await this.persist(config.threadId);
    await this.drain(rpc, config);
    const status = findById(this.entries, id)?.status ?? "unknown";

    log().info({ id, status }, "message.delivery");

    return { id, status };
  }

  /** Deliver one accepted receipt and durably acknowledge native completion.
  @param rpc - Connected native transport.
  @param config - Current validated configuration.
  @param receipt - Durable submission to deliver.
  */
  private async dispatch(rpc: CodexRpc, config: Config | undefined, receipt: Receipt) {
    if (!config) {
      throw new Error("Codex is unconfigured.");
    }

    await deliverMessage(rpc, config, this.snapshots, receipt);
    this.entries = receiptStatus(this.entries, receipt.id, "sent");
    await this.persist(config.threadId);
  }

  /**
  Persist retained receipts before publishing the pending queue.
  @param threadId - Configured parent identity, when available.
  */
  async persist(threadId: string | undefined) {
    if (threadId === undefined) {
      return;
    }

    this.entries = await persistReceipts(threadId, this.entries, this.pocketId);
    acceptTaskReceipts(threadId, this.entries, this.snapshots.state.scheduled);
    this.snapshots.state = { ...this.snapshots.state, queue: queuedReceipts(this.entries) };
    this.snapshots.publish(this.entries);
  }

  /**
  Restore interrupted sends as uncertain before publishing the pending queue.
  @param threadId - Parent conversation owning the private outbox.
  */
  async restore(threadId: string) {
    this.entries = await restoreReceipts(threadId, this.pocketId);
    await this.persist(threadId);
  }

  /**
  Persist restart recovery work only when hydrated history requires it.
  @param threadId - Parent conversation owning the recovery receipt.
  */
  async recover(threadId: string) {
    const recovery = recoveryReceipt(this.snapshots.state.turns, this.entries, crypto.randomUUID());

    if (!recovery) {
      return;
    }

    this.entries = [...this.entries, recovery];
    log().info({ id: recovery.id, threadId }, "recovery.queued");
    await this.persist(threadId);
  }

  /**
  Resolve idempotent retries before accepting a new durable submission.
  @param config - Validated parent configuration.
  @param rpc - Connected native client.
  @param id - Durable message identity.
  @param text - User message text.
  @param attachmentIds - Managed upload identifiers in request order.
  @param source - Optional finalized voice provenance retained in the durable receipt.
  @returns The existing or newly accepted delivery status.
  */
  async send(config: Config, rpc: CodexRpc, id: string, text: string, attachmentIds: string[], source?: MessageSource) {
    const existing = findById(this.entries, id);

    if (existing) {
      assertMessageContent(existing, text, attachmentIds);

      if (JSON.stringify(existing.source) !== JSON.stringify(source)) {
        throw new Error("This message ID already has different source provenance.");
      }

      return { id, status: existing.status };
    }

    return this.deliver(config, rpc, id, text, attachmentIds, source);
  }

  /**
  Dispatch queued receipts only while the owning parent is connected.
  @param rpc - Current native client, when available.
  @param config - Current validated parent configuration, when available.
  */
  async drain(rpc: CodexRpc | undefined, config: Config | undefined) {
    if (!rpc?.running || this.snapshots.state.connection !== "connected") {
      return;
    }

    for (const receipt of this.entries) {
      if (receipt.status !== "queued") {
        continue;
      }

      if (this.snapshots.state.activeTurnId && config?.activeMessageMode === "queue") {
        return;
      }

      this.entries = receiptStatus(this.entries, receipt.id, "sending");
      await this.persist(config?.threadId);
      const sent = await t(this.dispatch.bind(this), rpc, config, receipt);

      if (!sent.ok) {
        this.entries = receiptStatus(this.entries, receipt.id, "unknown");
        const persisted = await t(this.persist.bind(this), config?.threadId);
        const error = persisted.ok
          ? sent.error
          : new AggregateError(
              [sent.error, persisted.error],
              "Delivery failed and its uncertain status could not be saved."
            );

        this.snapshots.fail(error, this.entries);

        if (!persisted.ok) {
          throw error;
        }

        return;
      }
    }
  }
}
