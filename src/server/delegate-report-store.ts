import { object, string } from "../lib/protocol";
import { type Database } from "better-sqlite3";
import { type DelegateReport } from "../lib/delegate-reports";
import { delegationCommandSchema, delegationMailSchema } from "./delegation-data";
import { z } from "zod";
import { t as attempt } from "try";

const completedResultSchema = z.object({ status: z.literal("completed") });

/** Require typed native completion evidence; legacy diagnostics and plain-text results prove no finality.
@param result - Persisted native result or legacy diagnostic text.
@returns Whether the command has a validated successful native result.
*/
function hasSuccessfulResult(result: string | null) {
  if (!result) {
    return false;
  }

  const outcome = attempt(() => {
    return completedResultSchema.safeParse(JSON.parse(result)).success;
  });

  return outcome.ok && outcome.value;
}

/**
Project original reports without inference, leaving parent delivery and evidence unchanged.
*/
export class DelegateReportStore {
  /**
Bind the canonical private mailbox database.
@param db - Existing delegation database with parent-scoped originals.
*/
  constructor(private db: Database) {}

  /**
Read incoming originals in arrival order for direct read-only agent navigation.
@param parentId - Exact parent whose incoming reports may be displayed.
@returns Readable original report rows; no summarization or native work is started.
*/
  list(parentId: string): DelegateReport[] {
    const reports = z
      .array(delegationMailSchema)
      .parse(
        this.db
          .prepare("SELECT * FROM delegation_mail WHERE parentId=? AND delivery!='local' ORDER BY createdAt,rowid")
          .all(parentId)
      );
    const commands = z
      .array(delegationCommandSchema)
      .parse(
        this.db.prepare("SELECT * FROM delegation_commands WHERE parentId=? AND status='completed'").all(parentId)
      );
    const finalReports = new Map<string, string>();

    for (const command of commands) {
      if (!hasSuccessfulResult(command.result)) {
        continue;
      }

      const report = reports.findLast(
        (mail) =>
          mail.childId === command.childId &&
          (mail.sourceId === `result:${command.id}` || mail.sourceId.startsWith(`message:${command.id}:`))
      );

      if (report) {
        finalReports.set(report.id, command.id);
      }
    }

    return reports.map((mail) => {
      const payload = object(JSON.parse(mail.payload));
      const commandId = finalReports.get(mail.id);

      return {
        id: mail.id,
        agentId: `pocket:${mail.childId}`,
        status: "completed",
        text: string(payload.message) || string(payload.text) || mail.payload,
        ...(commandId && { final: { commandId, outcome: "completed" as const } }),
      };
    });
  }
}
