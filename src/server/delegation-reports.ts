import type { Config } from "./config";
import type { DelegationStore } from "./delegations";
import { log } from "./logging";
import { z } from "zod";

const deliveryStatus = z.enum(["queued", "sent", "unknown"]);

export interface ParentDelivery {
  send: (id: string, text: string) => Promise<{ status: string }>;
}

/**
Serializes durable delegate reports independently of child dispatch.
*/
export class ParentReports {
  private forwarding?: Promise<void>;
  private dirty = false;
  private stopped = false;

  /**
  Binds report delivery to the shared parent configuration.
  @param store - Durable mailbox owner.
  @param parent - Parent transport returning its delivery receipt.
  @param config - Shared configuration whose current thread selects pending mail.
  */
  constructor(
    private store: DelegationStore,
    private parent: ParentDelivery,
    private config: Config
  ) {}

  /**
  Delivers pending reports in order and persists recognized transport receipts.
  @returns Completion of this pending-mail pass; transport failures reject.
  */
  private async forward() {
    for (const mail of this.store.mail.pending(this.config.threadId)) {
      const child = this.store.get(mail.parentId, mail.childId);
      const text = `Side Pocket ${JSON.stringify(child.title)} (${child.harness}, ID ${child.id}) sent ${mail.kind}.
This is a report from your delegate. Interpret its contents in the context of the work you assigned.
${mail.payload}`;
      const receipt = await this.parent.send(mail.id, text);
      const delivery = deliveryStatus.safeParse(receipt.status);

      if (delivery.success) {
        this.store.mail.delivered(mail.id, delivery.data);
      }
    }
  }

  /**
  Logs transport failures while leaving undelivered mail available for reconciliation.
  @returns Completion of one delivery attempt.
  */
  private async forwardSafely() {
    try {
      await this.forward();
    } catch (error) {
      log().error({ error }, "side_pocket.forward_failed");
    }
  }

  /**
  Processes coalesced wakeups until stopped or no delivery pass remains.
  @returns Completion of all currently requested passes.
  */
  private async flush() {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      await this.forwardSafely();
    }
  }

  /**
  Reserves one delivery promise before starting work and retains wakeups during cleanup.
  @returns Completion of this serialized drain.
  */
  private async drain() {
    await Promise.resolve();

    try {
      await this.flush();
    } finally {
      this.forwarding = undefined;

      if (this.dirty && !this.stopped) {
        this.queue();
      }
    }
  }

  /**
  Requests a delivery pass without blocking command dispatch.
  */
  queue() {
    this.dirty = true;
    this.forwarding ??= this.drain();
  }

  /**
  Prevents another delivery pass while allowing an in-flight send to settle.
  */
  stop() {
    this.stopped = true;
  }

  /**
  Waits for any reserved or in-flight parent delivery.
  @returns Completion of the current delivery drain.
  */
  async settled() {
    await this.forwarding;
  }
}
