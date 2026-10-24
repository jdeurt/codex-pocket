import { readLocal, writeLocal } from "./local-state";
import { createHash } from "node:crypto";
import { type PiState, piStateSchema } from "../state/pi-session";

export type { PiState } from "../state/pi-session";

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
