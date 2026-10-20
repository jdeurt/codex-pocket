import { type AdoptedSession, type AdoptionInput, adoptionInput, sessionAttachment } from "./session-adoption";
import { pocket, storedPocketSchema } from "./delegation-data";
import type Database from "better-sqlite3";
import { type DelegationStore } from "./delegations";
import { createHash } from "node:crypto";

/**
Persist adopted identities without copying history or replaying their original assignment.
*/
export class DelegationAdoptions {
  /**
  Bind adoption to the same transactional ownership registry as normal delegates.
  @param db - Shared private database.
  @param store - Parent, queue and mailbox owner.
  */
  constructor(
    private db: Database.Database,
    private store: DelegationStore
  ) {}

  /**
  Reject self-adoption, parent cycles and duplicate management of the same session.
  @param parentId - Authorized parent.
  @param threadId - Native session being adopted.
  */
  private requireUnowned(parentId: string, threadId: string) {
    if (parentId === threadId || this.db.prepare("SELECT id FROM delegation_parents WHERE id=?").get(threadId)) {
      throw new Error("A main Pocket session cannot also become a delegate.");
    }

    if (this.db.prepare("SELECT id FROM side_pockets WHERE harness='codex' AND sessionId=?").get(threadId)) {
      throw new Error("This Codex session is already tracked by a Side Pocket.");
    }
  }

  /**
  Insert tracking and, for an active live session, a watch receipt that never sends a prompt.
  @param parentId - Authorized parent.
  @param input - Validated adoption request.
  @param session - Previously inspected native identity.
  @returns Durable child whose native session is unchanged.
  */
  private insert(parentId: string, input: AdoptionInput, session: AdoptedSession) {
    const parent = this.store.parent(parentId);
    const id = crypto.randomUUID();
    const now = Date.now();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ adoption: input }))
      .digest("hex");
    const attachment = input.socketPath ? { socketPath: input.socketPath, turnId: session.turnId } : undefined;

    this.requireUnowned(parentId, session.threadId);
    this.db
      .prepare(
        `INSERT INTO side_pockets
      (id,parentId,title,harness,cwd,sessionId,policy,status,createdAt,updatedAt,metadata,createKey,fingerprint)
      VALUES (?,?,?,'codex',?,?,?,'idle',?,?,?,?,?)`
      )
      .run(
        id,
        parentId,
        input.title,
        session.cwd,
        session.threadId,
        JSON.stringify(parent.policy),
        now,
        now,
        JSON.stringify({ adopted: true, sessionStarted: true, attachment }),
        input.idempotencyKey,
        fingerprint
      );

    if (attachment?.turnId) {
      this.watchCurrent(parentId, id, attachment.socketPath, attachment.turnId);
    }

    return this.store.get(parentId, id);
  }

  /**
  Queue observation only, with a fresh receipt tied to the owner's exact active turn.
  @param parentId - Authorized parent.
  @param id - Existing tracked child.
  @param socketPath - Explicit owning server.
  @param turnId - Current native turn, when one exists.
  */
  private watchCurrent(parentId: string, id: string, socketPath: string, turnId: string) {
    const command = this.store.queue.send(
      parentId,
      id,
      `observe:${crypto.randomUUID()}`,
      "Observe the existing Codex turn.",
      "queue"
    );

    this.store.metadata(parentId, id, { attachment: { socketPath, turnId, watchCommandId: command.id } });
  }

  /**
  Resolve identical retries before contacting a possibly disconnected native owner.
  @param parentId - Authorized parent.
  @param input - Validated adoption identity.
  @returns Existing adopted child, when the exact operation was committed before.
  */
  existing(parentId: string, input: AdoptionInput) {
    const existing = storedPocketSchema
      .optional()
      .parse(
        this.db
          .prepare("SELECT * FROM side_pockets WHERE parentId=? AND createKey=?")
          .get(parentId, input.idempotencyKey)
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ adoption: input }))
      .digest("hex");

    if (existing && existing.fingerprint !== fingerprint) {
      throw new Error("This creation key already belongs to different work.");
    }

    return existing ? pocket(existing) : undefined;
  }

  /**
  Reconnect tracking after an explicit resume, observing current work without replaying an assignment.
  @param parentId - Authorized parent.
  @param id - Existing adopted child.
  @param session - Fresh inspection of the same owning server.
  @returns Resumed child with a new watch receipt only when a native turn is active.
  */
  reconnect(parentId: string, id: string, session: AdoptedSession) {
    return this.db
      .transaction(() => {
        const child = this.store.get(parentId, id);
        const attachment = sessionAttachment(child.metadata);
        const watch = this.store.queue.list(parentId, id).find((command) => command.id === attachment?.watchCommandId);

        if (!attachment || child.sessionId !== session.threadId) {
          throw new Error("The inspected session does not match this live attachment.");
        }

        if (["running", "waiting", "closing"].includes(child.status)) {
          throw new Error("This live attachment is still active or closing. Inspect it before reconnecting.");
        }

        if (watch?.status === "queued") {
          return child;
        }

        this.store.resume(parentId, id);

        if (session.turnId) {
          this.watchCurrent(parentId, id, attachment.socketPath, session.turnId);
        }

        return this.store.get(parentId, id);
      })
      .immediate();
  }

  /**
  Commit adoption under an immediate transaction, rechecking ownership after native inspection.
  @param parentId - Authorized parent.
  @param value - Untrusted request revalidated at the storage boundary.
  @param session - Native inspection result.
  @returns Existing retry or newly adopted child.
  */
  adopt(parentId: string, value: unknown, session: AdoptedSession) {
    const input = adoptionInput.parse(value);

    if (input.threadId !== session.threadId) {
      throw new Error("The inspected session does not match the adoption request.");
    }

    return this.db
      .transaction(() => this.existing(parentId, input) ?? this.insert(parentId, input, session))
      .immediate();
  }
}
