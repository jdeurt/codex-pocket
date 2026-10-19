import type Database from "better-sqlite3";
import type { HarnessRequest } from "./harness/types";
import { createHash } from "node:crypto";
import { object } from "../lib/protocol";
import { validateAnswer } from "./answers";
import { z } from "zod";

const MAX_BODY_LENGTH = 65_536;
const HISTORY_LIMIT = 200;
export const parentMessageInput = z.object({ message: z.string().trim().min(1).max(MAX_BODY_LENGTH) }).strict();
export const delegationMessagePrefix = "pocket-delegate:";
export interface DelegationMail {
  id: string;
  childId: string;
  parentId: string;
  sourceId: string;
  kind: string;
  payload: string;
  delivery: "pending" | "queued" | "sent" | "unknown" | "local";
  createdAt: number;
}
export interface DelegationRequest {
  id: string;
  childId: string;
  parentId: string;
  nativeId: string;
  method: string;
  input: string;
  answer: string | null;
  status: "pending" | "answered" | "cancelled";
}

export class DelegationMailbox {
  constructor(
    private db: Database.Database,
    private changed: () => void
  ) {}
  record(parentId: string, childId: string, sourceId: string, kind: string, payload: unknown, notify = true) {
    const id = `${delegationMessagePrefix}${crypto.randomUUID()}`;
    this.db
      .prepare(`INSERT OR IGNORE INTO delegation_mail VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, childId, parentId, sourceId, kind, JSON.stringify(payload), notify ? "pending" : "local", Date.now());

    if (notify) {
      this.changed();
    }

    return this.db
      .prepare("SELECT * FROM delegation_mail WHERE childId=? AND sourceId=?")
      .get(childId, sourceId) as DelegationMail;
  }
  message(childId: string, commandId: string, input: unknown) {
    const { message } = parentMessageInput.parse(input);
    const command = this.db
      .prepare(
        `SELECT * FROM delegation_commands WHERE childId=? AND id=? AND status='running'
      AND EXISTS (SELECT 1 FROM side_pockets WHERE id=? AND status IN ('running','waiting'))`
      )
      .get(childId, commandId, childId) as { parentId: string } | undefined;

    if (!command) {
      throw new Error("This Side Pocket turn is no longer active.");
    }

    const digest = createHash("sha256").update(message).digest("hex");
    const mail = this.record(command.parentId, childId, `message:${commandId}:${digest}`, "message", { message });

    return { id: mail.id, queued: true, note: "The parent receives this message and can reply in this saved session." };
  }
  pending(parentId: string) {
    return this.db
      .prepare(
        "SELECT * FROM delegation_mail WHERE parentId=? AND delivery IN ('pending','queued') ORDER BY createdAt,rowid"
      )
      .all(parentId) as DelegationMail[];
  }
  delivered(id: string, status: "queued" | "sent" | "unknown") {
    this.db.prepare("UPDATE delegation_mail SET delivery=? WHERE id=?").run(status, id);
  }
  history(parentId: string, childId: string) {
    return this.db
      .prepare(
        "SELECT * FROM delegation_mail WHERE parentId=? AND childId=? ORDER BY createdAt DESC,rowid DESC LIMIT ?"
      )
      .all(parentId, childId, HISTORY_LIMIT)
      .toReversed() as DelegationMail[];
  }
  hasMessage(childId: string, commandId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM delegation_mail WHERE childId=? AND sourceId LIKE ? LIMIT 1")
      .get(childId, `message:${commandId}:%`);
  }
  request(parentId: string, childId: string, request: HarnessRequest) {
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO delegation_requests VALUES (?,?,?,?,?,?,NULL,'pending',?)")
      .run(id, childId, parentId, request.id, request.method, JSON.stringify(request.input), Date.now());
    this.record(parentId, childId, `request:${id}`, "request", { ...request, id });

    return id;
  }
  requests(parentId: string, childId: string, pendingOnly = false) {
    return this.db
      .prepare(
        "SELECT * FROM delegation_requests WHERE parentId=? AND childId=? AND (?=0 OR status='pending') ORDER BY createdAt"
      )
      .all(parentId, childId, Number(pendingOnly)) as DelegationRequest[];
  }
  answer(parentId: string, childId: string, id: string, answer: unknown) {
    return this.db
      .transaction(() => {
        const request = this.db
          .prepare("SELECT * FROM delegation_requests WHERE parentId=? AND childId=? AND id=?")
          .get(parentId, childId, id) as DelegationRequest | undefined;

        if (!request || request.status === "cancelled") {
          throw new Error("This request is no longer waiting. Send a follow-up to the saved Side Pocket session.");
        }

        const validated =
          request.method === "AskUserQuestion"
            ? z
                .object({ answers: z.record(z.string(), z.string()) })
                .strict()
                .parse(answer)
            : validateAnswer(
                { id: request.nativeId, method: request.method, params: object(JSON.parse(request.input)) },
                answer
              );
        const serialized = JSON.stringify(validated);

        if (request.status === "answered" && request.answer !== serialized) {
          throw new Error("This request already received a different answer.");
        }

        this.db.prepare("UPDATE delegation_requests SET answer=?,status='answered' WHERE id=?").run(serialized, id);
        this.changed();

        return { id, answered: true };
      })
      .immediate();
  }
  cancelRequests(childId: string) {
    const result = this.db
      .prepare("UPDATE delegation_requests SET status='cancelled' WHERE childId=? AND status='pending'")
      .run(childId);

    if (result.changes) {
      this.changed();
    }
  }
}
