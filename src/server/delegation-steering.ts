import { type DelegationCommand, delegationCommandSchema } from "./delegation-data";
import type Database from "better-sqlite3";
import { type DelegationNotifications } from "./delegation-notifications";
import { type SteeringResult } from "./harness/types";
import { z } from "zod";

/**
Own active-message delivery transitions in the existing durable command ledger.
*/
export class CommandSteering {
  readonly cancel;

  /**
Bind native persistence and committed-change notifications shared with the assignment queue.
@param db - Existing delegation database, never a second queue.
@param notifications - Worker wakeups after durable state changes.
*/
  constructor(
    private db: Database.Database,
    private notifications: DelegationNotifications
  ) {
    const cancel = this.db.transaction(this.cancelCommands.bind(this));

    this.cancel = cancel.immediate.bind(cancel);
  }

  /**
Cancel only selected unsent assignments and retain their reason in the audit ledger.
@param parentId - Authorizing parent identity.
@param childId - Managed child whose assignments may be withdrawn.
@param ids - Exact queued assignment identities, preserving all unrelated work.
@param reason - Parent's explicit cancellation or superseding explanation.
@returns The cancelled assignment identities, including identical retries.
*/
  private cancelCommands(parentId: string, childId: string, ids: string[], reason: string) {
    const commands: DelegationCommand[] = [];

    for (const id of ids) {
      const command = delegationCommandSchema.parse(
        this.db
          .prepare("SELECT * FROM delegation_commands WHERE parentId=? AND childId=? AND id=?")
          .get(parentId, childId, id)
      );

      if (command.mode !== "queue" || !["queued", "cancelled"].includes(command.status)) {
        throw new Error(
          "Only unsent queued assignments can be cancelled or superseded. Inspect attempted delivery outcomes first."
        );
      }

      commands.push(command);
    }

    for (const command of commands) {
      this.db
        .prepare("UPDATE delegation_commands SET status='cancelled',result=? WHERE id=? AND status='queued'")
        .run(reason, command.id);
      this.db
        .prepare("UPDATE delegation_commands SET status='cancelled',result=? WHERE targetId=? AND status='pending'")
        .run(`Target assignment cancelled: ${reason}`, command.id);
    }

    if (commands.length > 0) {
      this.notifications.changed();
    }

    return ids;
  }

  /**
Read unsent active corrections without including later assignments or attempted messages.
@param parentId - Configured parent whose native runs this worker owns.
@returns Pending corrections in committed creation order.
*/
  pending(parentId: string) {
    return z
      .array(delegationCommandSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM delegation_commands WHERE parentId=? AND status='pending' ORDER BY createdAt,rowid")
          .all(parentId)
      );
  }

  /**
Mark the send attempt before touching a native transport, preventing crash replay.
@param command - Persisted pending correction scoped to its current assignment.
@returns Whether this worker acquired the unsent correction.
*/
  claim(command: DelegationCommand) {
    return (
      this.db.prepare("UPDATE delegation_commands SET status='sending' WHERE id=? AND status='pending'").run(command.id)
        .changes > 0
    );
  }

  /**
Record the exact native delivery outcome without changing the active assignment's state.
@param command - Attempted correction with its stable native message identity.
@param result - Native acknowledgement, explicit rejection, or uncertain outcome.
*/
  finish(command: DelegationCommand, result: SteeringResult) {
    const status = result.status === "idle" ? "queued" : result.status;

    this.db
      .prepare(
        `UPDATE delegation_commands SET status=CASE
          WHEN ?='queued' AND EXISTS (SELECT 1 FROM side_pockets WHERE id=childId AND status IN ('closing','closed'))
          THEN 'cancelled' ELSE ? END,result=?,turnId=?,targetId=? WHERE id=? AND status='sending'`
      )
      .run(
        status,
        status,
        JSON.stringify(result),
        result.status === "accepted" ? result.turnId : null,
        result.status === "idle" ? null : command.targetId,
        command.id
      );
    this.notifications.changed();
  }

  /**
Release only never-attempted corrections after their target ends; accepted or uncertain work stays terminal.
@param targetId - Assignment that has completed or become uncertain.
*/
  release(targetId: string) {
    this.db
      .prepare("UPDATE delegation_commands SET status='queued',targetId=NULL WHERE targetId=? AND status='pending'")
      .run(targetId);
    this.notifications.changed();
  }
}
