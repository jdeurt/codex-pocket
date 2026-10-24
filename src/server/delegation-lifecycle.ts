import { localDirectory } from "./local-state";
import path from "node:path";
import { t } from "try";
import { requireResults } from "../lib/results";
import type { DelegationRun } from "./delegation-run";
import type { DelegationStore, SidePocket } from "./delegations";
import { log } from "./logging";

export interface RunningDelegation {
  run: DelegationRun;
  done: Promise<void>;
}

/** Close an owned native resource and join execution even if close fails.
@param running - Native resource and its existing completion.
*/
export async function closeDelegation(running: RunningDelegation) {
  const closed = await t(running.run.adapter.close.bind(running.run.adapter));
  const completed = await t(running.done);

  requireResults([closed, completed], "Delegated execution or native close failed.");
}

/** Interrupt before closing, preserving failures from every shutdown stage.
@param running - Native resource and existing execution.
*/
export async function interruptDelegation(running: RunningDelegation) {
  const interrupted = await t(running.run.adapter.interrupt.bind(running.run.adapter));
  const closed = await t(closeDelegation, running);

  requireResults([interrupted, closed], "Delegated interruption or shutdown failed.");
}

/** Observe a background execution immediately while retaining its rejecting completion for joins.
@param done - Existing execution completion.
@param childId - Owned native child identity.
*/
export async function observeDelegation(done: Promise<void>, childId: string) {
  const completed = await t(done);

  if (!completed.ok) {
    log().error({ error: completed.error, childId }, "side_pocket.execution_failed");
  }
}

/** Persist native output with a runtime-generated source identity.
@param store - Durable output owner.
@param child - Scoped child identity.
@param text - Native output.
*/
export function recordDelegationOutput(store: DelegationStore, child: SidePocket, text: string) {
  store.mail.record(child.parentId, child.id, `output:${crypto.randomUUID()}`, "output", { text }, false);
}

/**
Builds the scoped native MCP command used by one delegated assignment.
@param childId - Child identity used to authorize parent tools.
@param commandId - Claimed command whose requests and reports are attributed.
@returns Native stdio command and narrowly scoped environment.
*/
export function parentToolServer(childId: string, commandId: string) {
  return {
    command: process.execPath,
    args: [
      "--import",
      path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
      path.join(process.cwd(), "scripts/side-pocket-mcp.ts"),
    ],
    env: { CODEX_POCKET_STATE_DIR: localDirectory(), POCKET_CHILD_ID: childId, POCKET_COMMAND_ID: commandId },
  };
}
