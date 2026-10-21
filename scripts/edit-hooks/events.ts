import { ROOT, type ToolEvent } from "./shared";
import path from "node:path";
import { realpath } from "node:fs/promises";

/** Check that a native event belongs to this worktree.
@param directory - Resolved event directory.
@returns Whether this runner owns the event.
*/
function isInWorktree(directory: string): boolean {
  return directory === ROOT || directory.startsWith(`${ROOT}${path.sep}`);
}

/** Check native tool fields without trusting arbitrary tool arguments.
@param value - Parsed event object.
@returns Scoped event or null.
*/
async function toolEvent(value: object): Promise<ToolEvent | null> {
  const session_id: unknown = Reflect.get(value, "session_id");
  const turn_id: unknown = Reflect.get(value, "turn_id");
  const tool_use_id: unknown = Reflect.get(value, "tool_use_id");
  const cwd: unknown = Reflect.get(value, "cwd");
  const tool_name: unknown = Reflect.get(value, "tool_name");
  const tool_input: unknown = Reflect.get(value, "tool_input");
  const directory = typeof cwd === "string" ? await realpath(cwd) : ROOT;

  if (
    typeof session_id !== "string" ||
    typeof tool_use_id !== "string" ||
    typeof tool_name !== "string" ||
    (turn_id !== undefined && typeof turn_id !== "string") ||
    (cwd && typeof cwd !== "string")
  ) {
    throw new TypeError("native hook identifiers are unavailable");
  }

  return isInWorktree(directory)
    ? {
        session_id,
        tool_use_id,
        tool_name,
        tool_input,
        ...(typeof turn_id === "string" && { turn_id }),
        ...(typeof cwd === "string" && { cwd: directory }),
      }
    : null;
}

/** Parse native hook input without retaining source contents.
@param input - Serialized native event.
@returns Parsed object.
*/
function parseInput(input: string): object {
  const value: unknown = JSON.parse(input);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("native hook input is invalid");
  }

  return value;
}

/** Read the native hook event from standard input.
@returns Parsed event object.
*/
export async function nativeInput(): Promise<object> {
  let input = "";

  for await (const chunk of process.stdin) {
    input += String(chunk);
  }

  return parseInput(input);
}

/** Validate a native tool event for this worktree.
@returns Scoped event or null.
*/
export async function nativeEvent(): Promise<ToolEvent | null> {
  return toolEvent(await nativeInput());
}

/** Validate an interrupted main-thread turn for bookkeeping cleanup.
@param value - Parsed native event.
@returns Interrupted turn or null outside this checkout.
*/
async function interruptedTurn(
  value: object
): Promise<{ hook_event_name: "Interrupt"; session_id: string; turn_id: string } | null> {
  const session_id: unknown = Reflect.get(value, "session_id");
  const turn_id: unknown = Reflect.get(value, "turn_id");
  const cwd: unknown = Reflect.get(value, "cwd");
  const directory = typeof cwd === "string" ? await realpath(cwd) : null;

  if (typeof session_id !== "string" || typeof turn_id !== "string" || typeof cwd !== "string") {
    throw new TypeError("native interrupt identifiers are unavailable");
  }

  return directory !== null && isInWorktree(directory) ? { hook_event_name: "Interrupt", session_id, turn_id } : null;
}

/** Validate a tool or interruption event inside this worktree.
@param value - Parsed native hook input.
@returns Bookkeeping event or null outside this checkout.
*/
export async function bookkeepingEvent(
  value: object
): Promise<ToolEvent | { hook_event_name: "Interrupt"; session_id: string; turn_id: string } | null> {
  return Reflect.get(value, "hook_event_name") === "Interrupt" ? interruptedTurn(value) : toolEvent(value);
}
