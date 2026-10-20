import { type CodexRpc } from "./rpc";
import { type Config } from "./config";
import { type Receipt } from "./outbox";
import { type Snapshot } from "../lib/protocol";
import { deliverMessage } from "./delivery";

export async function drainReceipts(
  rpc: CodexRpc,
  config: Config | undefined,
  state: Snapshot,
  receipts: Receipt[],
  persist: () => Promise<void>,
  fail: (error: unknown) => void
) {
  for (const receipt of receipts) {
    if (receipt.status !== "queued") {
      continue;
    }

    if (state.activeTurnId && config?.activeMessageMode === "queue") {
      return;
    }

    receipt.status = "sending";
    await persist();

    try {
      if (!config) {
        throw new Error("Codex is unconfigured.");
      }

      await deliverMessage(rpc, config, state, receipt);
      receipt.status = "sent";
      await persist();
    } catch (error) {
      receipt.status = "unknown";
      await persist();
      fail(error);

      // Never automatically replay a message with an uncertain outcome.
      return;
    }
  }
}
