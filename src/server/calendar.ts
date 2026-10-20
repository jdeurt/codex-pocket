import path from "node:path";
import { spawn } from "node:child_process";

export { normalizeCalendar } from "./calendar-validation";

const CALCULATION_TIMEOUT_MS = 2000;

/**
Validate one untrusted recurrence-process response against the requested occurrence boundary.
@param output - Complete native child stdout containing JSON.
@param after - Requested epoch boundary that the next occurrence must strictly exceed.
@returns Finite next epoch time, or null when the recurrence has ended.
*/
function decodedOccurrence(output: string, after: number): number | null {
  const value: unknown = JSON.parse(output);

  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= after)) {
    throw new Error("Calendar returned an invalid next occurrence.");
  }

  return value;
}

/**
Evaluate one normalized recurrence in its bounded native child process.
@param calendar - Calendar text normalized by the shared validation boundary.
@param after - Epoch boundary after which an occurrence is requested.
@returns Next epoch time or null, rejecting native failures and the existing evaluation deadline.
*/
export async function nextOccurrence(calendar: string, after: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let output = "";
    let diagnostic = "";

    const child = spawn(process.execPath, [path.resolve("scripts/calendar-worker.mjs")], {
      env: { ...process.env, TZ: "UTC" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Calendar recurrence took too long to evaluate. Simplify the rule."));
    }, CALCULATION_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      diagnostic += String(data);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(`Invalid calendar recurrence: ${diagnostic.trim()}`));

        return;
      }

      try {
        resolve(decodedOccurrence(output, after));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Invalid calendar response.", { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify({ calendar, after }));
  });
}
