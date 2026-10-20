import {
  DELEGATE_SUMMARY_PROMPT,
  type DelegateMail,
  delegateOriginal,
  delegateSummaryInput,
} from "./delegate-summary-prompt";
import { type DelegateReport } from "../lib/delegate-reports";
import { type Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { delegationMailSchema } from "./delegation-data";
import { z } from "zod";

const cachedSummarySchema = z.object({
  text: z.string(),
  status: z.enum(["streaming", "completed", "failed"]),
  owner: z.number(),
});

/**
Determine whether a transform's owning process still exists without sending it a signal.
@param pid - Process that atomically claimed this display transform.
@returns Whether the process exists, including a process whose access is restricted.
*/
function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
Own durable display projections independently of original mail and delivery receipts.
*/
export class DelegateSummaryStore {
  /**
Bind the existing private database and committed display-change notification.
@param db - Canonical delegation database.
@param changed - Callback invoked after a projection write.
*/
  constructor(
    private db: Database,
    private changed: () => void
  ) {}

  /**
Read all parent-bound originals in their durable arrival order.
@param parentId - Exact parent whose incoming reports are being projected.
@returns Original reports, excluding local-only child output.
*/
  reports(parentId: string) {
    return z
      .array(delegationMailSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM delegation_mail WHERE parentId=? AND delivery!='local' ORDER BY createdAt,rowid")
          .all(parentId)
      );
  }

  /**
Hash the fixed transformation contract with the exact report envelope and content.
@param mail - Original report whose stable ID also scopes the cache.
@returns Content and contract digest used by every cache operation.
*/
  private digest(mail: DelegateMail) {
    return createHash("sha256").update(DELEGATE_SUMMARY_PROMPT).update(delegateSummaryInput(mail)).digest("hex");
  }

  /**
Read a cached projection only for this stable report and exact transformation contract.
@param mail - Persisted original report.
@returns Validated cached projection, or undefined before claiming.
*/
  private cached(mail: DelegateMail) {
    return cachedSummarySchema
      .optional()
      .parse(
        this.db
          .prepare("SELECT text,status,owner FROM delegate_summaries WHERE messageId=? AND digest=?")
          .get(mail.id, this.digest(mail))
      );
  }

  /**
Claim a new transform atomically across server processes without replaying existing claims.
@param mail - Durable parent-bound report.
@returns Whether this process owns the sole invocation for this report and content.
*/
  claim(mail: DelegateMail) {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO delegate_summaries (messageId,digest,text,status,owner) VALUES (?,?,'','streaming',?)"
      )
      .run(mail.id, this.digest(mail), process.pid);

    if (result.changes > 0) {
      this.changed();
    }

    return result.changes > 0;
  }

  /**
Persist streamed paraphrase text or its terminal outcome without changing original mail.
@param mail - Stable source report owned by this process's claim.
@param text - Full paraphrase accumulated so far; empty on failure.
@param status - Streaming, successful, or failed display-transform state.
*/
  write(mail: DelegateMail, text: string, status: "streaming" | "completed" | "failed") {
    this.db
      .prepare(
        "UPDATE delegate_summaries SET text=?,status=? WHERE messageId=? AND digest=? AND owner=? AND status='streaming'"
      )
      .run(text, status, mail.id, this.digest(mail), process.pid);
    this.changed();
  }

  /**
Project incoming reports immediately and retain exact source text after failure or process loss.
@param parentId - Exact parent whose report projections are requested.
@returns UI-only report rows with stable sending-agent navigation identities.
*/
  list(parentId: string): DelegateReport[] {
    return this.reports(parentId).map((mail) => {
      const cached = this.cached(mail);
      const isFailed = cached?.status === "failed" || (cached?.status === "streaming" && !isProcessAlive(cached.owner));

      return {
        id: mail.id,
        agentId: `pocket:${mail.childId}`,
        status: isFailed ? "failed" : (cached?.status ?? "pending"),
        text: isFailed ? delegateOriginal(mail) : (cached?.text ?? ""),
      };
    });
  }
}
