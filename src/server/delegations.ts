import {
  type ParentContext,
  type SidePocket,
  parentContextSchema,
  pocket,
  storedPocketSchema,
} from "./delegation-data";
import { delegationDatabase, lastCommandStatus } from "./delegation-db";
import { DelegationMailbox } from "./delegation-mail";
import { DelegationNotifications } from "./delegation-notifications";
import { DelegationQueue } from "./delegation-queue";
import { claudePermissions } from "./harness/permissions";
import { createHash } from "node:crypto";
import { delegationInput } from "./delegation-input";
import { log } from "./logging";
import { requireClaudeBinary } from "./harness/claude-binary";
import { z } from "zod";

const RECOVERY_MESSAGE =
  "Pocket restarted during this turn. Its outcome is unknown. Inspect the saved history and send a follow-up to continue; the original work will not be replayed automatically.";

export { delegations } from "./delegation-runtime";
export { MAX_CONCURRENT_CHILDREN } from "./delegation-queue";
export { delegationInput, delegationKey, delegationBody } from "./delegation-input";

export type { DelegationCommand, ParentContext, SidePocket, StoredPocket } from "./delegation-data";

/**
Own private parent and child identities, composing their durable mailbox and command queue.
*/
export class DelegationStore {
  private db;

  private notifications: DelegationNotifications;

  readonly mail: DelegationMailbox;

  readonly queue: DelegationQueue;

  /**
Read the newest persisted command outcome for one parent-owned child.
@param parentId - Recorded parent scope.
@param childId - Managed child whose latest outcome is requested.
@returns Latest validated command status, or undefined when no command exists.
*/
  lastCommandStatus = (parentId: string, childId: string) => lastCommandStatus(this.db, parentId, childId);

  /**
Acquire private persistence, committed-change hints and concrete mailbox and queue owners.
@param directory - Private state directory used by this process or isolated fixture.
*/
  constructor(directory: string) {
    this.db = delegationDatabase(directory);
    this.notifications = new DelegationNotifications(directory);
    this.mail = new DelegationMailbox(this.db, this.notifications.changed);
    this.queue = new DelegationQueue(this.db, this, this.notifications);
  }

  /**
Insert a new child and its first command only after retry and native-policy checks succeed.
@param parentId - Recorded parent scope.
@param value - Validated creation input with its stable retry identity.
@param parent - Recorded native parent context and effective policy.
@param fingerprint - Exact normalized-input digest already checked for retries.
@returns Newly persisted normalized child identity.
*/
  private insertChild(
    parentId: string,
    value: z.infer<typeof delegationInput>,
    parent: ParentContext,
    fingerprint: string
  ) {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO side_pockets
        (id,parentId,title,harness,cwd,model,effort,policy,status,createdAt,updatedAt,createKey,fingerprint)
        VALUES (?,?,?,?,?,?,?,?,'idle',?,?,?,?)`
      )
      .run(
        id,
        parentId,
        value.title,
        value.harness,
        value.cwd ?? parent.cwd,
        value.model ?? null,
        value.effort ?? null,
        JSON.stringify(parent.policy),
        now,
        now,
        value.idempotencyKey,
        fingerprint
      );
    this.queue.send(parentId, id, "initial", value.body);
    log().info({ parentId, childId: id, input: value }, "side_pocket.created");

    return this.get(parentId, id);
  }

  /**
Observe committed delegation changes through the existing native directory watcher.
@param listener - Owner callback that rechecks persisted work.
@returns Cleanup releasing this exact change subscription.
*/
  subscribe(listener: () => void) {
    return this.notifications.subscribe(listener);
  }

  /**
Persist the native parent's effective working directory and access policy.
@param id - Native parent conversation identity.
@param context - Validated native parent context inherited by managed children.
*/
  saveParent(id: string, context: ParentContext) {
    this.db
      .prepare("INSERT INTO delegation_parents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET context=excluded.context")
      .run(id, JSON.stringify(context));
  }

  /**
Require and validate the recorded native parent context before child operations.
@param id - Native parent conversation identity.
@returns Validated parent context or the existing unconfigured-parent error.
*/
  parent(id: string): ParentContext {
    const row = z
      .object({ context: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT context FROM delegation_parents WHERE id=?").get(id));

    if (!row) {
      throw new Error("Parent Pocket must connect before delegating work.");
    }

    return parentContextSchema.parse(JSON.parse(row.context));
  }

  /**
Read normalized managed children within the recorded parent scope.
@param parentId - Recorded parent scope.
@returns Persisted children in deterministic creation order.
*/
  list(parentId: string) {
    const rows = z
      .array(storedPocketSchema)
      .parse(this.db.prepare("SELECT * FROM side_pockets WHERE parentId=? ORDER BY createdAt,id").all(parentId));

    return rows.map((row) => pocket(row));
  }

  /**
Require a normalized child belonging to the exact recorded parent.
@param parentId - Recorded parent scope.
@param id - Managed child identity requested within that scope.
@returns Normalized persisted child or the existing ownership error.
*/
  get(parentId: string, id: string) {
    const row = storedPocketSchema
      .optional()
      .parse(this.db.prepare("SELECT * FROM side_pockets WHERE parentId=? AND id=?").get(parentId, id));

    if (!row) {
      throw new Error("Side Pocket not found for this parent. Use side_pocket_list to look up titles and IDs.");
    }

    return pocket(row);
  }

  /**
Validate creation input and deduplicate it inside the existing immediate transaction.
@param parentId - Recorded parent scope.
@param input - Untrusted creation input with a stable idempotency key.
@returns Existing identical child or a new child with its initial queued assignment.
*/
  create(parentId: string, input: unknown) {
    const value = delegationInput.parse(input);
    const parent = this.parent(parentId);
    const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");

    return this.db
      .transaction(() => {
        const existing = storedPocketSchema
          .optional()
          .parse(
            this.db
              .prepare("SELECT * FROM side_pockets WHERE parentId=? AND createKey=?")
              .get(parentId, value.idempotencyKey)
          );

        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new Error("This creation key already belongs to different work.");
          }

          return pocket(existing);
        }

        if (value.harness === "claude") {
          claudePermissions(parent.policy);
          requireClaudeBinary();
        }

        return this.insertChild(parentId, value, parent, fingerprint);
      })
      .immediate();
  }

  /**
Persist a parent-owned child's lifecycle state before publishing a committed-change hint.
@param parentId - Recorded parent scope.
@param id - Managed child identity.
@param status - Existing persisted child lifecycle state.
*/
  setStatus(parentId: string, id: string, status: SidePocket["status"]) {
    this.db
      .prepare("UPDATE side_pockets SET status=?,updatedAt=? WHERE parentId=? AND id=?")
      .run(status, Date.now(), parentId, id);
    this.notifications.changed();
  }

  /**
Resume only waiting or running children without undoing a concurrent persisted close request.
@param parentId - Recorded parent scope.
@param id - Managed child whose native request was answered.
@returns Whether the guarded persisted transition succeeded.
*/
  continueChild(parentId: string, id: string) {
    // A concurrent answer must never undo a persisted close request.
    return (
      this.db
        .prepare(
          "UPDATE side_pockets SET status='running',updatedAt=? WHERE parentId=? AND id=? AND status IN ('waiting','running')"
        )
        .run(Date.now(), parentId, id).changes > 0
    );
  }

  /**
Persist the native saved session identity for one parent-owned child.
@param parentId - Recorded parent scope.
@param id - Managed child identity.
@param sessionId - Native saved session identity retained across follow-ups.
*/
  setSession(parentId: string, id: string, sessionId: string) {
    this.db
      .prepare("UPDATE side_pockets SET sessionId=?,updatedAt=? WHERE parentId=? AND id=?")
      .run(sessionId, Date.now(), parentId, id);
  }

  /**
Merge native lifecycle display metadata into the child's private persisted JSON.
@param parentId - Recorded parent scope.
@param id - Managed child identity.
@param data - Native metadata patch serialized for SQLite's existing JSON merge.
*/
  metadata(parentId: string, id: string, data: unknown) {
    this.db
      .prepare("UPDATE side_pockets SET metadata=json_patch(metadata,?) WHERE parentId=? AND id=?")
      .run(JSON.stringify(data), parentId, id);
  }

  /**
Atomically persist close intent and cancel queued work and pending native requests.
@param parentId - Recorded parent scope.
@param id - Managed child to close without deleting its saved identity.
@returns Updated persisted child including an already closed child.
*/
  closeChild(parentId: string, id: string) {
    return this.db
      .transaction(() => {
        const child = this.get(parentId, id);

        if (child.status !== "closed") {
          this.setStatus(parentId, id, "closing");
        }

        this.db
          .prepare("UPDATE delegation_commands SET status='cancelled' WHERE childId=? AND status='queued'")
          .run(id);
        this.mail.cancelRequests(id);

        return this.get(parentId, id);
      })
      .immediate();
  }

  /**
Reopen a closed or uncertain saved child only after any native close has finished.
@param parentId - Recorded parent scope.
@param id - Saved managed child identity to retain.
@returns Updated child retaining its original identity and native saved session.
*/
  resume(parentId: string, id: string) {
    const child = this.get(parentId, id);

    if (child.status === "closing") {
      throw new Error("Side Pocket is still closing its process; retry after it closes.");
    }

    if (["closed", "unknown"].includes(child.status)) {
      this.setStatus(parentId, id, "idle");
    }

    return this.get(parentId, id);
  }

  /**
Record interrupted native commands as uncertain without replaying their work.
@param parentId - Configured parent whose persisted child work is being recovered.
*/
  recover(parentId: string) {
    for (const child of this.list(parentId)) {
      for (const command of this.queue.list(parentId, child.id)) {
        if (command.status !== "running") {
          continue;
        }

        this.queue.recordResult(command, "unknown", RECOVERY_MESSAGE, {
          sourceId: `recovery:${command.id}`,
          kind: "recovery",
          payload: { message: RECOVERY_MESSAGE, commandId: command.id },
        });
        log().info({ childId: child.id, commandId: command.id }, "side_pocket.recovered");
      }

      this.mail.cancelRequests(child.id);
    }
  }

  /**
Release only this store's notification watcher and private database handle.
*/
  close() {
    this.notifications.close();
    this.db.close();
  }
}
