import { type CodexRpc } from "./rpc";
import { type Config } from "./config";
import { type Receipt } from "./outbox";
import { type Snapshot } from "../lib/protocol";
import { deliverMessage } from "./delivery";

/**
Dispatch one sending receipt and durably acknowledge success only after native delivery resolves.
@param rpc - Connected native client.
@param config - Parent configuration whose absence must fail this attempt.
@param state - Canonical parent state used for start or steer selection.
@param receipt - Receipt already durably marked sending.
@param persist - Owner operation recording the completed status transition.
*/
async function dispatchReceipt(
  rpc: CodexRpc,
  config: Config | undefined,
  state: Snapshot,
  receipt: Receipt,
  persist: () => Promise<void>
) {
  if (!config) {
    throw new Error("Codex is unconfigured.");
  }

  await deliverMessage(rpc, config, state, receipt);
  receipt.status = "sent";
  await persist();
}

/**
Deliver queued receipts serially and stop permanently at an uncertain outcome.
@param rpc - Connected native protocol client.
@param config - Validated parent configuration, when available.
@param state - Canonical snapshot whose active turn controls steer versus queue behavior.
@param receipts - Persisted receipt queue in delivery order.
@param persist - Owner operation that durably records each status transition.
@param fail - Owner operation that publishes a delivery failure.
*/
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
      await dispatchReceipt(rpc, config, state, receipt, persist);
    } catch (error) {
      receipt.status = "unknown";
      await persist();
      fail(error);

      // Never automatically replay a message with an uncertain outcome.
      return;
    }
  }
}
