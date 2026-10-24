import { delegateReports } from "../state/delegate-reports";
import { type Database } from "better-sqlite3";
import { type DelegateReport } from "../lib/delegate-reports";
import { delegationCommandSchema, delegationMailSchema } from "./delegation-data";
import { z } from "zod";

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

    return delegateReports(reports, commands);
  }
}
