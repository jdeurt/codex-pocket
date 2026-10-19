import type { ChildContext, Harness, ParentPolicy } from "./harness/types";
import { DelegationMailbox } from "./delegation-mail";
import { claudePermissions } from "./harness/permissions";
import { createHash } from "node:crypto";
import { delegationDatabase } from "./delegation-db";
import { localDirectory } from "./local-state";
import { log } from "./logging";
import { requireClaudeBinary } from "./harness/claude-binary";
import { z } from "zod";

const MAX_TITLE_LENGTH = 160;
const MAX_BODY_LENGTH = 32_768;
export const delegationKey = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
export const delegationBody = z.string().trim().min(1).max(MAX_BODY_LENGTH);
export const delegationInput = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    body: delegationBody,
    harness: z.enum(["codex", "claude"]).default("codex"),
    cwd: z.string().startsWith("/").optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    idempotencyKey: delegationKey,
  })
  .strict();
export interface SidePocket extends ChildContext {
  harness: Harness;
  status: "idle" | "running" | "waiting" | "closing" | "closed" | "unknown";
  createdAt: number;
  updatedAt: number;
  metadata: string;
}
interface StoredPocket extends Omit<SidePocket, "policy"> {
  policy: string;
  fingerprint: string;
}
export interface DelegationCommand {
  id: string;
  childId: string;
  parentId: string;
  body: string;
  status: "queued" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  result: string | null;
}
interface ParentContext {
  cwd: string;
  policy: ParentPolicy;
}

function pocket(row: StoredPocket): SidePocket {
  return { ...row, policy: JSON.parse(row.policy) };
}

export class DelegationStore {
  private db;
  readonly mail: DelegationMailbox;
  constructor(directory: string) {
    this.db = delegationDatabase(directory);
    this.mail = new DelegationMailbox(this.db);
  }
  saveParent(id: string, context: ParentContext) {
    this.db
      .prepare("INSERT INTO delegation_parents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET context=excluded.context")
      .run(id, JSON.stringify(context));
  }
  parent(id: string): ParentContext {
    const row = this.db.prepare("SELECT context FROM delegation_parents WHERE id=?").get(id) as
      { context: string } | undefined;

    if (!row) {
      throw new Error("Parent Pocket must connect before delegating work.");
    }

    return JSON.parse(row.context);
  }
  list(parentId: string) {
    const rows = this.db
      .prepare("SELECT * FROM side_pockets WHERE parentId=? ORDER BY createdAt,id")
      .all(parentId) as StoredPocket[];

    return rows.map((row) => pocket(row));
  }
  get(parentId: string, id: string) {
    const row = this.db.prepare("SELECT * FROM side_pockets WHERE parentId=? AND id=?").get(parentId, id) as
      StoredPocket | undefined;

    if (!row) {
      throw new Error("Side Pocket not found for this parent. Use side_pocket_list to look up titles and IDs.");
    }

    return pocket(row);
  }
  create(parentId: string, input: unknown) {
    const value = delegationInput.parse(input);
    const parent = this.parent(parentId);
    const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");

    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM side_pockets WHERE parentId=? AND createKey=?")
        .get(parentId, value.idempotencyKey) as StoredPocket | undefined;

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
      this.send(parentId, id, "initial", value.body);
      log().info({ parentId, childId: id, input: value }, "side_pocket.created");

      return this.get(parentId, id);
    })();
  }
  send(parentId: string, childId: string, key: string, body: string) {
    delegationKey.parse(key);
    const text = delegationBody.parse(body);
    const child = this.get(parentId, childId);
    const existing = this.db
      .prepare("SELECT * FROM delegation_commands WHERE childId=? AND key=?")
      .get(childId, key) as DelegationCommand | undefined;

    if (existing) {
      if (existing.body !== text) {
        throw new Error("This message key already belongs to different text.");
      }

      return existing;
    }

    if (["closing", "closed", "unknown"].includes(child.status)) {
      throw new Error("Resume this Side Pocket before sending more work. Inspect unknown outcomes before continuing.");
    }

    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO delegation_commands VALUES (?,?,?,?,?,'queued',NULL,?)")
      .run(id, childId, parentId, key, text, Date.now());

    return this.db.prepare("SELECT * FROM delegation_commands WHERE id=?").get(id) as DelegationCommand;
  }
  commands(parentId: string, childId: string) {
    return this.db
      .prepare("SELECT * FROM delegation_commands WHERE parentId=? AND childId=? ORDER BY createdAt,rowid")
      .all(parentId, childId) as DelegationCommand[];
  }
  claim(parentId: string, childId: string) {
    return this.db.transaction(() => {
      const child = this.get(parentId, childId);

      if (child.status !== "idle") {
        return;
      }

      const command = this.commands(parentId, childId).find((entry) => entry.status === "queued");

      if (!command) {
        return;
      }

      this.db.prepare("UPDATE delegation_commands SET status='running' WHERE id=?").run(command.id);
      this.db
        .prepare("UPDATE side_pockets SET status='running',policy=?,updatedAt=? WHERE parentId=? AND id=?")
        .run(JSON.stringify(this.parent(parentId).policy), Date.now(), parentId, childId);

      return command;
    })();
  }
  setStatus(parentId: string, id: string, status: SidePocket["status"]) {
    this.db
      .prepare("UPDATE side_pockets SET status=?,updatedAt=? WHERE parentId=? AND id=?")
      .run(status, Date.now(), parentId, id);
  }
  setSession(parentId: string, id: string, sessionId: string) {
    this.db
      .prepare("UPDATE side_pockets SET sessionId=?,updatedAt=? WHERE parentId=? AND id=?")
      .run(sessionId, Date.now(), parentId, id);
  }
  metadata(parentId: string, id: string, data: unknown) {
    this.db
      .prepare("UPDATE side_pockets SET metadata=json_patch(metadata,?) WHERE parentId=? AND id=?")
      .run(JSON.stringify(data), parentId, id);
  }
  finish(command: DelegationCommand, status: DelegationCommand["status"], result: string) {
    this.db.prepare("UPDATE delegation_commands SET status=?,result=? WHERE id=?").run(status, result, command.id);
    const child = this.get(command.parentId, command.childId);

    if (!["closing", "closed"].includes(child.status)) {
      this.setStatus(command.parentId, command.childId, status === "unknown" ? "unknown" : "idle");
    }
  }
  recordResult(
    command: DelegationCommand,
    status: DelegationCommand["status"],
    result: string,
    report?: { sourceId: string; kind: string; payload: unknown }
  ) {
    this.db.transaction(() => {
      this.finish(command, status, result);

      if (report) {
        this.mail.record(command.parentId, command.childId, report.sourceId, report.kind, report.payload);
      }
    })();
  }
  closeChild(parentId: string, id: string) {
    return this.db.transaction(() => {
      const child = this.get(parentId, id);

      if (child.status !== "closed") {
        this.setStatus(parentId, id, "closing");
      }

      this.db.prepare("UPDATE delegation_commands SET status='cancelled' WHERE childId=? AND status='queued'").run(id);
      this.mail.cancelRequests(id);

      return this.get(parentId, id);
    })();
  }
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
  recover(parentId: string) {
    for (const child of this.list(parentId)) {
      for (const command of this.commands(parentId, child.id)) {
        if (command.status !== "running") {
          continue;
        }

        const message =
          "Pocket restarted during this turn. Its outcome is unknown. Inspect the saved history and send a follow-up to continue; the original work will not be replayed automatically.";
        this.recordResult(command, "unknown", message, {
          sourceId: `recovery:${command.id}`,
          kind: "recovery",
          payload: { message, commandId: command.id },
        });
        log().info({ childId: child.id, commandId: command.id }, "side_pocket.recovered");
      }

      this.mail.cancelRequests(child.id);
    }
  }
  close() {
    this.db.close();
  }
}

declare global {
  var codexPocketDelegations: DelegationStore | undefined;
}

export function delegations() {
  if (!globalThis.codexPocketDelegations) {
    Object.defineProperty(globalThis, "codexPocketDelegations", {
      value: new DelegationStore(localDirectory()),
      configurable: true,
    });
  }

  return globalThis.codexPocketDelegations as DelegationStore;
}
