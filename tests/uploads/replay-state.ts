import { readFile, writeFile } from "node:fs/promises";
import { type APIResponse } from "@playwright/test";
import path from "node:path";
import { uploadRequestSchema } from "../fixtures/replay-protocol";

export const directory = path.resolve(".local/uploads-replay");

/**
Sends one control command to this offline native upload replay.
@param action - Completion, disconnect or duplicate-image action selected by the workflow.
@returns Completion of the private control-file write.
*/
export function control(action: string) {
  return writeFile(path.join(directory, "control.json"), JSON.stringify({ id: crypto.randomUUID(), action }));
}

/**
Reads normalized native upload receipts from this replay's append-only request log.
@returns Captured deliveries, or an empty list before a readable log exists.
*/
export async function requests() {
  return readFile(path.join(directory, "requests.jsonl"), "utf8")
    .then((text) => {
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => uploadRequestSchema.parse(JSON.parse(line)));
    })
    .catch(() => {
      return [];
    });
}

/**
Resolves an actual API response to its HTTP success status.
@param promise - Pending request made by the native Playwright API client.
@returns Whether the server accepted the request.
*/
export async function isOk(promise: Promise<APIResponse>) {
  const response = await promise;

  return response.ok();
}

/**
Counts durable native deliveries for one idempotent browser submission.
@param id - Client message identity recovered from the persisted outbox.
@returns Number of captured deliveries with this identity.
*/
export async function deliveredCount(id: string) {
  const entries = await requests();

  return entries.filter((entry) => entry.clientUserMessageId === id).length;
}
