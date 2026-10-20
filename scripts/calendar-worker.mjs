import rrule from "rrule";
import { z } from "zod";

const requestSchema = z.object({ calendar: z.string(), after: z.number() });

/**
Compute the next native recurrence after validating one untrusted stdin request.
@param {string} source - Complete JSON request from the owning bounded calendar process.
@returns {string} The next epoch time or null serialized for the parent protocol.
*/
function calendarResult(source) {
  const { calendar, after } = requestSchema.parse(JSON.parse(source));
  const rule = rrule.rrulestr(calendar, { forceset: true, compatible: true });
  const next = rule.after(new Date(after));

  return next ? JSON.stringify(next.getTime()) : "null";
}

let input = "";

for await (const chunk of process.stdin) {
  input += String(chunk);
}

try {
  process.stdout.write(calendarResult(input));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
