import { z } from "zod";
import { t } from "try";
import type Database from "better-sqlite3";
import { delegationDatabase } from "../server/delegation-db";
import { localDirectory } from "../server/local-state";
import { valueAfterCleanup } from "../lib/results";
import { TASK_CLASSIFIERS } from "./classifier-definitions";
import type { Ledger } from "./model";
import type { CommandEvidence } from "./lifecycle-evidence";

const commandSchema = z.object({
  id: z.string(),
  childId: z.string(),
  status: z.string(),
  body: z.string(),
  mode: z.string(),
  targetId: z.string().nullable(),
});
const commandsSchema = z.array(commandSchema);

/** Interpret execution settlement while preserving accepted steering as a receipt for its exact target command.
@param recorded - Actual native command, when present.
@param rows - Parent-owned command rows.
@returns Whether this command has no running or uncertain execution dependency.
*/
function isCommandSettled(recorded: z.infer<typeof commandSchema> | undefined, rows: z.infer<typeof commandSchema>[]) {
  if (!recorded) {
    return false;
  }

  const terminal: readonly string[] = TASK_CLASSIFIERS.lifecycle.settledCommandStatuses;

  if (terminal.includes(recorded.status)) {
    return true;
  }

  for (const target of rows) {
    if (recorded.mode === "steer" && recorded.status === "accepted" && recorded.targetId === target.id) {
      return terminal.includes(target.status);
    }
  }

  return false;
}

/** Read exact per-command execution status inside its recorded parent namespace.
@param db - Owned native command database handle.
@param parentId - Authorized parent.
@param commands - Ledger-owned command identities selected for one task.
@returns Bounded command facts; missing records remain unknown.
*/
function commandFacts(db: Database.Database, parentId: string, commands: Ledger["commands"]) {
  const rows = commandsSchema.parse(
    db.prepare("SELECT id,childId,status,body,mode,targetId FROM delegation_commands WHERE parentId=?").all(parentId)
  );
  const facts: CommandEvidence[] = [];

  for (const command of commands) {
    let recorded: z.infer<typeof commandSchema> | undefined;

    for (const row of rows) {
      if (row.id === command.id && row.childId === command.childId) {
        recorded = row;
      }
    }

    facts.push({
      id: command.id,
      childId: command.childId,
      status: recorded?.status ?? "unknown",
      body: recorded?.body.slice(0, TASK_CLASSIFIERS.lifecycle.maxEvidenceLength) ?? "",
      isSettled: isCommandSettled(recorded, rows),
    });
  }

  return facts;
}

/** Own native command-state reads independently of classifier network calls and ledger transactions.
@param parentId - Authorized parent.
@param commands - Exact task command identities.
@returns Application-owned execution facts for stale checks and lifecycle guards.
*/
export function readCommandEvidence(parentId: string, commands: Ledger["commands"]) {
  if (commands.length === 0) {
    return [];
  }

  const db = delegationDatabase(localDirectory());
  const result = t(commandFacts, db, parentId, commands);
  const closed = t(db.close.bind(db));

  return valueAfterCleanup(result, closed);
}
