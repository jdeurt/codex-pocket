import type { ChildContext } from "./types";
import { ADOPTED_SIDE_ORIENTATION, SIDE_INSTRUCTIONS } from "../pocket-prompts";
import { object } from "../../lib/protocol";

/**
Compose the shared Side Pocket contract, opening adopted sessions with their verified relationship.
@param child - Scoped native identity, working directory and persisted adoption metadata.
@returns Approved instructions without altering the underlying harness prompt.
*/
export function sidePocketInstructions(child: ChildContext) {
  const fields: Record<string, string> = {
    parentId: JSON.stringify(child.parentId),
    id: JSON.stringify(child.id),
    title: JSON.stringify(child.title),
    cwd: JSON.stringify(child.cwd),
    sessionId: JSON.stringify(child.sessionId),
  };
  const adopted = child.metadata && object(JSON.parse(child.metadata)).adopted === true;
  const instructions = adopted ? `${ADOPTED_SIDE_ORIENTATION}\n${SIDE_INSTRUCTIONS}` : SIDE_INSTRUCTIONS;

  let result = "";
  let offset = 0;

  for (const match of instructions.matchAll(/\{(parentId|id|title|cwd|sessionId)\}/g)) {
    result += instructions.slice(offset, match.index) + (fields[match[1]] ?? match[0]);
    offset = match.index + match[0].length;
  }

  return result + instructions.slice(offset);
}
