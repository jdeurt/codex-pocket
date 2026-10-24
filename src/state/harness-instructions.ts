import type { ChildContext } from "../server/harness/types";
import { object } from "../lib/protocol";

/**
Compose the shared Side Pocket contract, opening adopted sessions with their verified relationship.
@param child - Scoped native identity, working directory and persisted adoption metadata.
@param prompts - Prompt text loaded by the native runtime.
@returns Approved instructions without altering the underlying harness prompt.
*/
export function sidePocketInstructions(child: ChildContext, prompts: { side: string; adopted: string }) {
  const fields: Record<string, string> = {
    parentId: JSON.stringify(child.parentId),
    id: JSON.stringify(child.id),
    title: JSON.stringify(child.title),
    cwd: JSON.stringify(child.cwd),
    sessionId: JSON.stringify(child.sessionId),
  };
  const adopted = child.metadata && object(JSON.parse(child.metadata)).adopted === true;
  const instructions = adopted ? `${prompts.adopted}\n${prompts.side}` : prompts.side;

  let result = "";
  let offset = 0;

  for (const match of instructions.matchAll(/\{(parentId|id|title|cwd|sessionId)\}/g)) {
    result += instructions.slice(offset, match.index) + (fields[match[1]] ?? match[0]);
    offset = match.index + match[0].length;
  }

  return result + instructions.slice(offset);
}
