import { Bridge } from "../../src/server/bridge";
import { type Snapshot } from "../../src/lib/protocol";
import { setTimeout as pause } from "node:timers/promises";
import { visibleSnapshot } from "../../src/server/visible-snapshot";
import { z } from "zod";

const SETTLE_ATTEMPTS = 200;
const SETTLE_INTERVAL_MS = 10;
const commandSchema = z.object({ id: z.string(), text: z.string().optional() });

/**
Waits for the isolated bridge's native turn and queued deliveries to settle.
@param bridge - Actual bridge connected only to the offline restart replay.
@returns Stable canonical snapshot; an unresponsive fake transport rejects.
*/
async function settledSnapshot(bridge: Bridge): Promise<Snapshot> {
  for (let retry = 0; retry < SETTLE_ATTEMPTS; retry += 1) {
    if (
      !bridge.snapshot.activeTurnId &&
      bridge.snapshot.queue.every((entry) => entry.status !== "queued" && entry.status !== "sending")
    ) {
      return bridge.snapshot;
    }

    await pause(SETTLE_INTERVAL_MS);
  }

  throw new Error("The isolated bridge did not settle.");
}

/**
Responds with both actual canonical state and its phone projection after the command settles.
@param bridge - Actual bridge scoped to private fake native state.
@returns Completion of the IPC snapshot response.
*/
async function reportSnapshot(bridge: Bridge) {
  const snapshot = await settledSnapshot(bridge);

  process.send?.({ raw: snapshot, visible: visibleSnapshot(snapshot) });
}

/**
Validates the IPC command once before operating the real offline bridge.
@param bridge - Actual bridge connected to the fake native child.
@param input - Untrusted host IPC message.
@returns Completion of optional send and settled snapshot reporting.
*/
async function respond(bridge: Bridge, input: unknown) {
  const command = commandSchema.parse(input);

  await bridge.ensureConnected();

  if (command.text) {
    await bridge.send(command.id, command.text);
  }

  await reportSnapshot(bridge);
}

/**
Owns this private bridge worker's IPC and native transport until host shutdown.
*/
function worker() {
  const bridge = new Bridge();

  process.on("message", (input: unknown) => {
    void respond(bridge, input).catch((error: unknown) => process.send?.({ error: String(error) }));
  });
  process.once("SIGTERM", () => {
    bridge.close();
    process.disconnect();
  });
}

worker();
