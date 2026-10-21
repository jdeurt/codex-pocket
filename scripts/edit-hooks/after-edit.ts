import { HookFailure, type ToolEvent, acquireLock, nativeEvent, stateDirectory, stateName } from "./shared";
import { checkChanged } from "./format";
import { claim } from "./tracking";
import path from "node:path";
import { rm } from "node:fs/promises";

/** Check one claimed tool edit after acquiring the runner lock.
@param directory - Worktree state directory.
@param event - Completed tool event.
@returns Informational feedback, or null.
*/
async function checkClaim(directory: string, event: ToolEvent): Promise<string | null> {
  const state = await claim(directory, event);

  return state
    ? checkChanged(state.baseline, state.targets)
    : "After-edit check skipped overlapping edits whose ownership is ambiguous.";
}

/** Release a tool claim and runner lock even if state removal fails.
@param source - Tool state file.
@param lock - Runner lock directory.
*/
async function releaseClaim(source: string, lock: string): Promise<void> {
  try {
    await rm(source, { force: true });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Release this tool's state if another runner holds the lock too long.
@param directory - Worktree state directory.
@param source - Tool state file.
@returns Claimed runner lock.
*/
async function lockForTool(directory: string, source: string): Promise<string> {
  try {
    return await acquireLock(directory);
  } catch (error) {
    await rm(source, { force: true });
    throw error;
  }
}

/** Return developer context without replacing the completed tool result.
@param message - Informational diagnostics or runtime failure.
*/
function feedback(message: string): void {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } })}\n`
  );
}

/** Consume one before-tool snapshot and check changed files under a lock.
@param event - Validated native event.
@returns Informational feedback or null.
*/
async function afterEvent(event: ToolEvent): Promise<string | null> {
  const directory = await stateDirectory();
  const source = path.join(directory, stateName(event));
  const lock = await lockForTool(directory, source);

  try {
    return await checkClaim(directory, event);
  } finally {
    await releaseClaim(source, lock);
  }
}

/** Run one scoped sequential check after the tool finishes.
@returns Feedback, or null when the final files are clean.
*/
async function after(): Promise<string | null> {
  const event = await nativeEvent();

  return event ? afterEvent(event) : null;
}

/**
Emit only the after-tool context returned by the runner.
*/
async function runAndReport(): Promise<void> {
  const message = await after();

  if (message) {
    feedback(message);
  }
}

try {
  await runAndReport();
} catch (error) {
  const reason =
    error instanceof HookFailure
      ? error.message
      : "the hook runtime failed; review local dependencies and configuration";

  feedback(`After-edit check could not run: ${reason}.`);
}
