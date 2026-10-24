import { type Result } from "try";

/** Resolve completed work after cleanup, preserving both failures when neither succeeded.
@param completed - Captured operation outcome.
@param cleanup - Captured unconditional cleanup outcome.
@returns Successful operation value when both outcomes succeeded.
*/
export function valueAfterCleanup<T>(completed: Result<T>, cleanup: Result<unknown>): T {
  if (!completed.ok && !cleanup.ok) {
    throw new AggregateError([completed.error, cleanup.error], "Operation and cleanup both failed.");
  }

  if (!completed.ok) {
    throw completed.error;
  }

  if (!cleanup.ok) {
    throw cleanup.error;
  }

  return completed.value;
}

/** Require every captured operation to succeed without losing concurrent failures.
@param results - Explicit outcomes from independent operations.
@param message - Context for aggregate diagnostics.
*/
export function requireResults(results: readonly Result<unknown>[], message: string) {
  const errors: unknown[] = [];

  for (const result of results) {
    if (!result.ok) {
      errors.push(result.error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}

/** Inspect all native settlements before completing resource shutdown.
@param results - Settled native operations.
@param message - Context for aggregate diagnostics.
*/
export function requireSettled(results: readonly PromiseSettledResult<unknown>[], message: string) {
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}
