import { object, string } from "../lib/protocol";
import type { DelegateReport } from "../lib/delegate-reports";
import type { DelegationCommand, delegationMailSchema } from "./delegation-data";
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

  const outcome = attempt(JSON.parse, result);

  return outcome.ok && completedResultSchema.safeParse(outcome.value).success;
}

/** Select original mailbox text and verified completion evidence from explicit durable rows.
@param reports - Scoped incoming reports in chronological order.
@param commands - Scoped commands already marked completed by storage.
@returns Independent display records retaining original evidence.
*/
export function delegateReports(
  reports: z.infer<typeof delegationMailSchema>[],
  commands: DelegationCommand[]
): DelegateReport[] {
  const finalReports = new Map<string, string>();

  for (const command of commands) {
    if (!hasSuccessfulResult(command.result)) {
      continue;
    }

    let latest: string | undefined;

    for (const mail of reports) {
      if (
        mail.childId === command.childId &&
        (mail.sourceId === `result:${command.id}` || mail.sourceId.startsWith(`message:${command.id}:`))
      ) {
        latest = mail.id;
      }
    }

    if (latest) {
      finalReports.set(latest, command.id);
    }
  }

  const entries: DelegateReport[] = [];

  for (const mail of reports) {
    const payload = object(JSON.parse(mail.payload));
    const commandId = finalReports.get(mail.id);

    entries.push({
      id: mail.id,
      agentId: `pocket:${mail.childId}`,
      status: "completed",
      text: string(payload.message) || string(payload.text) || mail.payload,
      ...(commandId && { final: { commandId, outcome: "completed" } }),
    });
  }

  return entries;
}
