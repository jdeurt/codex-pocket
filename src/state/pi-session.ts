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

/** Detect native Pi history before allowing a missing empty session to be recreated.
@param turns - Saved canonical history.
@returns Whether any native Pi message has been preserved.
*/
export function hasPiHistory(turns: Turn[]) {
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.source === "pi") {
        return true;
      }
    }
  }

  return false;
}

/** Restore receipt identities and mark interrupted host work without changing stored input.
@param state - Saved or migrated canonical projection.
@param sessionFile - Current native session path.
@returns Restored independent projection.
*/
export function restoredPiState(state: PiState, sessionFile: string): PiState {
  const turns: Turn[] = [];

  for (const turn of state.turns) {
    const items = Array.from(turn.items, (item) =>
      item.source === "pi" && item.type === "userMessage" ? { ...item, clientId: item.clientId ?? item.id } : item
    );

    const restored = { ...turn, items };

    turns.push(
      turn.status === "inProgress"
        ? {
            ...restored,
            status: "interrupted",
            error: { message: "The host stopped during this Pi turn. Inspect saved context before continuing." },
          }
        : restored
    );
  }

  return { ...state, sessionFile, turns };
}
