import { delegationMailSchema, delegationRequestSchema } from "./delegation-data";
import type Database from "better-sqlite3";
import { type HarnessRequest } from "./harness/types";
import { createHash } from "node:crypto";
import { object } from "../lib/protocol";
import { validateAnswer } from "../state/answers";
import { z } from "zod";

const MAX_BODY_LENGTH = 65_536;
const HISTORY_LIMIT = 200;
export const parentMessageInput = z.object({ message: z.string().trim().min(1).max(MAX_BODY_LENGTH) }).strict();
export const delegationMessagePrefix = "pocket-delegate:";

export type DelegationRequest = z.infer<typeof delegationRequestSchema>;

/**
Own durable parent reports and native requests scoped to managed child identities.
*/
export class DelegationMailbox {
  /**
Bind the private database and committed-change notifier without dispatching work.
@param db - Native private delegation database.
@param changed - Callback publishing a change hint after the owning transaction commits.
*/
  constructor(
    private db: Database.Database,
    private changed: () => void
  ) {}

  /**
Persist an active child's parent message under its content-derived retry identity.
@param parentId - Recorded parent that owns the active command.
@param childId - Managed child identity verified by the active-command query.
@param commandId - Running native command owning this message.
@param message - Validated exact parent message text.
@returns Persisted report acknowledgement using the existing parent-delivery contract.
*/
  private recordMessage(parentId: string, childId: string, commandId: string, message: string) {
    const digest = createHash("sha256").update(message).digest("hex");
    const mail = this.record(parentId, childId, `message:${commandId}:${digest}`, "message", { message });

    return { id: mail.id, queued: true, note: "The parent receives this message and can reply in this saved session." };
  }

  /**
Validate and atomically persist an owned pending answer without replacing a different prior answer.
@param request - Persisted request checked inside the owning immediate transaction.
@param answer - Untrusted answer validated against the native request protocol.
@returns Existing acknowledgement of the persisted native answer.
*/
  private answerRequest(request: DelegationRequest, answer: unknown) {
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

    this.db.prepare("UPDATE delegation_requests SET answer=?,status='answered' WHERE id=?").run(serialized, request.id);
    this.changed();

    return { id: request.id, answered: true };
  }

  /**
Persist a source-deduplicated child report before hinting that parent delivery is available.
@param parentId - Recorded parent scope.
@param childId - Managed child producing this report.
@param sourceId - Stable source identity deduplicated within the child.
@param kind - Existing report, request or result discriminator.
@param payload - Protocol data serialized exactly once for private persistence.
@param shouldNotify - Whether the report enters parent delivery or remains local.
@returns Validated persisted report, including an existing report on retry.
*/
  record(parentId: string, childId: string, sourceId: string, kind: string, payload: unknown, shouldNotify = true) {
    const id = `${delegationMessagePrefix}${crypto.randomUUID()}`;

    this.db
      .prepare(`INSERT OR IGNORE INTO delegation_mail VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        id,
        childId,
        parentId,
        sourceId,
        kind,
        JSON.stringify(payload),
        shouldNotify ? "pending" : "local",
        Date.now()
      );

    if (shouldNotify) {
      this.changed();
    }

    return delegationMailSchema.parse(
      this.db.prepare("SELECT * FROM delegation_mail WHERE childId=? AND sourceId=?").get(childId, sourceId)
    );
  }

  /**
Accept a parent message only from a still-active managed child command.
@param childId - Managed child identity supplied by its dedicated connection.
@param commandId - Running command identity bound to that connection.
@param input - Untrusted parent-message input parsed by the shared schema.
@returns Persisted parent-delivery acknowledgement.
*/
  message(childId: string, commandId: string, input: unknown) {
    const { message } = parentMessageInput.parse(input);
    const command = z
      .object({ parentId: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT * FROM delegation_commands WHERE childId=? AND id=? AND status='running'
      AND EXISTS (SELECT 1 FROM side_pockets WHERE id=? AND status IN ('running','waiting'))`
          )
          .get(childId, commandId, childId)
      );

    if (!command) {
      throw new Error("This Side Pocket turn is no longer active.");
    }

    return this.recordMessage(command.parentId, childId, commandId, message);
  }

  /**
Read ordered undelivered reports only for their recorded parent.
@param parentId - Parent scope required by the delivery query.
@returns Validated pending or queued parent reports in durable order.
*/
  pending(parentId: string) {
    return z
      .array(delegationMailSchema)
      .parse(
        this.db
          .prepare(
            "SELECT * FROM delegation_mail WHERE parentId=? AND delivery IN ('pending','queued') ORDER BY createdAt,rowid"
          )
          .all(parentId)
      );
  }

  /**
Persist a changed delivery receipt and notify observers without waking them for identical retries.
@param id - Persisted parent-report identity.
@param status - Delivery status returned by the parent receipt boundary.
*/
  delivered(id: string, status: "queued" | "sent" | "unknown") {
    const result = this.db
      .prepare("UPDATE delegation_mail SET delivery=? WHERE id=? AND delivery!=?")
      .run(status, id, status);

    if (result.changes > 0) {
      this.changed();
    }
  }

  /**
Read bounded child report history in chronological display order.
@param parentId - Recorded parent scope.
@param childId - Managed child whose reports belong to that parent.
@returns Validated report history retaining the existing bounded window.
*/
  history(parentId: string, childId: string) {
    return z
      .array(delegationMailSchema)
      .parse(
        this.db
          .prepare(
            "SELECT * FROM delegation_mail WHERE parentId=? AND childId=? ORDER BY createdAt DESC,rowid DESC LIMIT ?"
          )
          .all(parentId, childId, HISTORY_LIMIT)
          .toReversed()
      );
  }

  /**
Check whether a command already reported its final text, allowing silent completion after an explicit report.
@param childId - Managed child identity.
@param commandId - Command whose source-prefixed messages are checked.
@param text - Native final response; progress alone must not suppress a different completed result.
@returns Whether the native result adds no content to existing explicit reports.
*/
  hasResult(childId: string, commandId: string, text: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM delegation_mail WHERE childId=? AND sourceId LIKE ? " +
          "AND (?='' OR json_extract(payload,'$.message')=?) LIMIT 1"
      )
      .get(childId, `message:${commandId}:%`, text.trim(), text.trim());
  }

  /**
Persist a native child request before recording its informational parent report.
@param parentId - Recorded parent scope.
@param childId - Managed child that owns the native request.
@param request - Normalized native question or approval request.
@returns Stable persisted request identity used for parent answers.
*/
  request(parentId: string, childId: string, request: HarnessRequest) {
    const id = crypto.randomUUID();

    this.db
      .prepare("INSERT INTO delegation_requests VALUES (?,?,?,?,?,?,NULL,'pending',?)")
      .run(id, childId, parentId, request.id, request.method, JSON.stringify(request.input), Date.now());
    this.record(parentId, childId, `request:${id}`, "request", { ...request, id });

    return id;
  }

  /**
Read native child requests within their recorded parent and optional pending filter.
@param parentId - Recorded parent scope.
@param childId - Managed child whose requests are inspected.
@param isPendingOnly - Whether answered and cancelled history is excluded.
@returns Validated native request records in creation order.
*/
  requests(parentId: string, childId: string, isPendingOnly = false) {
    return z
      .array(delegationRequestSchema)
      .parse(
        this.db
          .prepare(
            "SELECT * FROM delegation_requests WHERE parentId=? AND childId=? AND (?=0 OR status='pending') ORDER BY createdAt"
          )
          .all(parentId, childId, Number(isPendingOnly))
      );
  }

  /**
Hold an immediate transaction while verifying ownership and persisting a validated native answer.
@param parentId - Recorded parent permitted to answer.
@param childId - Managed child owning the request.
@param id - Persisted request identity returned by the child request boundary.
@param answer - Untrusted native answer input.
@returns Persisted answer acknowledgement, including an identical retry.
*/
  answer(parentId: string, childId: string, id: string, answer: unknown) {
    return this.db
      .transaction(() => {
        const request = delegationRequestSchema
          .optional()
          .parse(
            this.db
              .prepare("SELECT * FROM delegation_requests WHERE parentId=? AND childId=? AND id=?")
              .get(parentId, childId, id)
          );

        if (!request || request.status === "cancelled") {
          throw new Error("This request is no longer waiting. Send a follow-up to the saved Side Pocket session.");
        }

        return this.answerRequest(request, answer);
      })
      .immediate();
  }

  /**
Cancel a child's pending native requests and publish a hint only when rows changed.
@param childId - Managed child whose pending requests must stop.
*/
  cancelRequests(childId: string) {
    const result = this.db
      .prepare("UPDATE delegation_requests SET status='cancelled' WHERE childId=? AND status='pending'")
      .run(childId);

    if (result.changes) {
      this.changed();
    }
  }
}
