import type { ChildContext } from "./types";
import { SIDE_INSTRUCTIONS } from "../pocket-prompts";

/**
Append the approved Side Pocket contract with runtime identities serialized as data.
@param child - Scoped native identity, display title and working directory.
@returns Approved instructions without altering the underlying harness prompt.
*/
export function sidePocketInstructions(child: ChildContext) {
  const fields: Record<string, string> = {
    parentId: JSON.stringify(child.parentId),
    id: JSON.stringify(child.id),
    title: JSON.stringify(child.title),
    cwd: JSON.stringify(child.cwd),
  };

  return SIDE_INSTRUCTIONS.replaceAll(
    /\{(parentId|id|title|cwd)\}/g,
    (placeholder, name: string) => fields[name] ?? placeholder
  );
}
