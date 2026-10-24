import { readFile, writeFile } from "node:fs/promises";
import { RECOVERY_PROMPT } from "../../src/state/recovery";
import type { RestartHost } from "./restart-host";
import { type Snapshot } from "../../src/lib/protocol";
import { outboxSchema } from "../../src/server/outbox";
import path from "node:path";

export type RestartSnapshots = Awaited<ReturnType<RestartHost["snapshot"]>>;

/**
Selects restart notices from the actual canonical phone transcript.
@param state - Normalized native or phone snapshot.
@returns Restart notice items in chronological transcript order.
*/
export function events(state: Snapshot) {
  return state.turns.flatMap((turn) => turn.items).filter((item) => item.type === "pocketRestart");
}

/**
Adds a reserved recovery receipt while the fake bridge process is stopped.
@param directory - Private bridge state directory.
@param id - Explicit recovery receipt identity selected by the scenario.
@param status - Pending or uncertain delivery outcome to persist.
@returns Completion of the normalized durable outbox update.
*/
export async function appendRecovery(directory: string, id: string, status: "queued" | "unknown") {
  const outboxFile = path.join(directory, "outbox.json");
  const outbox = outboxSchema.parse(JSON.parse(await readFile(outboxFile, "utf8")));

  outbox.receipts.push({ id, text: RECOVERY_PROMPT, status });
  await writeFile(outboxFile, JSON.stringify(outbox));
}
