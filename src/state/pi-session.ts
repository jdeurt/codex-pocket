import { type Turn, turnSchema } from "../lib/protocol";
import { upsertById } from "../lib/identity";
import { z } from "zod";

export const piStateSchema = z.object({ sessionFile: z.string(), name: z.string(), turns: z.array(turnSchema) });

export type PiState = z.infer<typeof piStateSchema>;
export interface PiHistoryState {
  saved?: PiState;
  activeId?: string;
}

/** Replace a canonical turn without mutating accepted history.
@param state - Previous canonical state.
@param turn - Updated native turn.
@param activeId - Explicit current-turn identity.
@returns Independent canonical state.
*/
export function piTurnState(state: PiHistoryState, turn: Turn, activeId: string | undefined): PiHistoryState {
  if (!state.saved) {
    throw new Error("Pi history is not initialized.");
  }

  return { saved: { ...state.saved, turns: upsertById(state.saved.turns, turn) }, activeId };
}
