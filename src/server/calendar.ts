import path from "node:path";
import { spawn } from "node:child_process";
import { t as attempt } from "try";

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
Own one bounded native recurrence calculation, its streams and completion.
*/
class CalendarCalculation {
  private readonly completion = Promise.withResolvers<number | null>();
  private readonly child;
  private readonly timer;
  private output = "";
  private diagnostic = "";

  /** Retain complete stdout until the child closes its stream.
  @param data - Native stdout chunk.
  */
  private stdout = (data: unknown) => {
    this.output += String(data);
  };

  /** Retain native diagnostics for a failed calculation.
  @param data - Native stderr chunk.
  */
  private stderr = (data: unknown) => {
    this.diagnostic += String(data);
  };

  /** Reject this calculation and stop its owned subprocess.
  @param error - Original native failure.
  */
  private failed = (error: Error) => {
    clearTimeout(this.timer);
    this.child.kill("SIGKILL");
    this.completion.reject(error);
  };

  /**
  Stop a calculation that exceeds its resource deadline.
  */
  private timeout = () => {
    this.failed(new Error("Calendar recurrence took too long to evaluate. Simplify the rule."));
  };

  /** Decode complete output after native streams close.
  @param code - Native process exit code.
  */
  private closed = (code: number | null) => {
    clearTimeout(this.timer);

    if (code !== 0) {
      this.completion.reject(new Error(`Invalid calendar recurrence: ${this.diagnostic.trim()}`));

      return;
    }

    const outcome = attempt(decodedOccurrence, this.output, this.after);

    if (outcome.ok) {
      this.completion.resolve(outcome.value);
    } else {
      this.completion.reject(outcome.error);
    }
  };

  /** Launch one isolated recurrence worker.
  @param calendar - Validated recurrence text.
  @param after - Explicit lower occurrence boundary.
  */
  constructor(
    calendar: string,
    private readonly after: number
  ) {
    this.child = spawn(process.execPath, [path.resolve("scripts/calendar-worker.mjs")], {
      env: { ...process.env, TZ: "UTC" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.timer = setTimeout(this.timeout, CALCULATION_TIMEOUT_MS);
    this.child.stdout.on("data", this.stdout);
    this.child.stderr.on("data", this.stderr);
    this.child.stdin.once("error", this.failed);
    this.child.once("error", this.failed);
    this.child.once("close", this.closed);
    this.child.stdin.end(JSON.stringify({ calendar, after }));
  }

  /** Expose this native operation's completion.
  @returns Validated next occurrence or the original failure.
  */
  get result() {
    return this.completion.promise;
  }
}

/** Evaluate a recurrence in a bounded native process.
@param calendar - Validated recurrence text.
@param after - Explicit lower occurrence boundary.
@returns Next occurrence or null when the rule has ended.
*/
export function nextOccurrence(calendar: string, after: number): Promise<number | null> {
  return new CalendarCalculation(calendar, after).result;
}
