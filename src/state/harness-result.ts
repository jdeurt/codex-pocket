import { type Turn, string } from "../lib/protocol";
import type { HarnessResult } from "../server/harness/types";

/** Select original assistant output and native terminal status from explicit observations.
@param turn - Native terminal turn.
@param output - Assistant text observed on the live transport.
@returns Native completion result without claiming success for unknown status.
*/
export function codexResult(turn: Turn, output: ReadonlyMap<string, string>): HarnessResult {
  const messages: string[] = [];

  for (const item of turn.items) {
    if (item.type === "agentMessage") {
      messages.push(string(item.text));
    }
  }

  return {
    status: turn.status === "completed" || turn.status === "interrupted" ? turn.status : "failed",
    text: messages.join("\n\n") || output.values().toArray().join("\n\n") || (turn.error?.message ?? ""),
  };
}

/** Select the latest native active turn that has not already completed locally.
@param turns - Native history in chronological order.
@param completed - Terminal results already observed on this transport.
@returns Current turn identity, or undefined.
*/
export function activeNativeTurn(turns: readonly Turn[], completed: ReadonlyMap<string, HarnessResult>) {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];

    if (turn.status === "inProgress" && !completed.has(turn.id)) {
      return turn.id;
    }
  }
}
