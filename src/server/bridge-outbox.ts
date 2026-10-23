import { type Receipt, persistReceipts, restoreReceipts } from "./outbox";
import { assertMessageContent, resolveUploads } from "./uploads";
import type { BridgeSnapshots } from "./bridge-snapshots";
import type { CodexRpc } from "./rpc";
import type { Config } from "./config";
import { drainReceipts } from "./bridge-delivery";
import { isQueueRecovery } from "./recovery";
import { log } from "./logging";
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
    const receipt: Receipt = { id, text, source, ...(attachments.length > 0 && { attachments }), status: "queued" };

    this.entries.push(receipt);
    await this.persist(config.threadId);
    await this.drain(rpc, config);
    log().info({ id, status: receipt.status }, "message.delivery");

    return { id, status: receipt.status };
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
    this.snapshots.state.queue = this.entries.filter((entry) => entry.status !== "sent");
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
    if (isQueueRecovery(this.snapshots.state, this.entries)) {
      await this.persist(threadId);
    }
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
    const existing = this.entries.find((entry) => entry.id === id);

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

    await drainReceipts(
      rpc,
      config,
      this.snapshots.state,
      this.entries,
      () => this.persist(config?.threadId),
      (error) => {
        this.snapshots.fail(error, this.entries);
      }
    );
  }
}
