import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

const JOURNAL = "unexpected-requests.jsonl";

/** Reject unmodeled native work and retain evidence even when Pocket handles the RPC error.
@param method - Unexpected external operation observed by this replay process.
*/
export function unexpectedRequest(method: string | undefined): never {
  const directory = process.env.CODEX_POCKET_STATE_DIR;

  assert.ok(directory, "Native replay requires explicit private state before recording a mismatch");
  appendFileSync(path.join(directory, JOURNAL), JSON.stringify({ method: method ?? "missing-method" }) + "\n");
  throw new Error(`Unexpected fixture operation: ${String(method)}`);
}

/** Fail the owning workflow for unmatched native calls, including swallowed transport errors.
@param directory - Private state shared with the owned native replay processes.
*/
export async function assertExpectedRequests(directory: string) {
  const journal = await readFile(path.join(directory, JOURNAL), "utf8").catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }

    return "";
  });

  assert.equal(journal, "", `Unmatched native requests:\n${journal}`);
}
