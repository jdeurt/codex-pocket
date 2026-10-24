import { readLocal, writeLocal } from "./local-state";
import { createHash } from "node:crypto";
import { turnSchema } from "../lib/protocol";
import { z } from "zod";

const piStateSchema = z.object({
  sessionFile: z.string(),
  name: z.string(),
  turns: z.array(turnSchema),
});

export type PiState = z.infer<typeof piStateSchema>;

/** Namespace Pi's durable projection by the existing Pocket identity.
@param owner - Parent conversation identity.
@returns Relative private state filename.
*/
function piStateFile(owner: string) {
  return `pi-main/${createHash("sha256").update(owner).digest("hex")}.json`;
}

/** Restore Pi history without replaying accepted submissions.
@param owner - Exact parent identity.
@returns Validated native session path and UI history, or null before migration.
*/
export async function readPiState(owner: string) {
  return piStateSchema.nullable().parse(await readLocal(piStateFile(owner), null));
}

/** Save the Pi session pointer and canonical phone transcript atomically.
@param owner - Exact parent identity.
@param state - Authoritative Pi pointer and projection.
@returns Completion after the projection is durable.
*/
export function savePiState(owner: string, state: PiState) {
  return writeLocal(piStateFile(owner), state);
}

/** Serialize captured projections without discarding earlier persistence failures.
@param previous - Preceding durable write.
@param owner - Parent identity.
@param state - Projection captured when the caller queued this write.
*/
export async function savePiStateAfter(previous: Promise<void>, owner: string, state: PiState | undefined) {
  await previous;

  if (state) {
    await savePiState(owner, state);
  }
}
