import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { taskDirectory, writeTaskFile } from "./archive";
import { readTaskLedger } from "./management";
import { classifyTaskLedger } from "./classification-runtime";
import { latestDecision } from "./reconciliation";
import { isParentTaskFile } from "./retrieval/paths";
import type { Ledger } from "./model";

const legacyGroupSchema = z.object({
  id: z.string(),
  owner: z.string(),
  matched: z.array(z.string()),
  status: z.string(),
});
const legacyMetadataSchema = z.object({ metadata: legacyGroupSchema });

export interface LegacyMembership {
  taskId: string;
  nativeEntryId: string;
  status: string;
  file: string;
}

/** Read only explicit legacy membership metadata from validated parent archives.
@param parentId - Authorized parent.
@returns Existing memberships without semantic reclassification or source replay.
*/
export async function legacyMemberships(parentId: string): Promise<LegacyMembership[]> {
  const directory = taskDirectory(parentId);
  const names = await readdir(directory);
  const members: LegacyMembership[] = [];

  for (const name of names) {
    if (["active.json", "routing-shadow.json"].includes(name) || !name.endsWith(".json")) {
      continue;
    }

    const file = path.join(directory, name);

    if (!(await isParentTaskFile(parentId, file))) {
      continue;
    }

    const parsed = legacyMetadataSchema.safeParse(JSON.parse(await readFile(file, "utf8")));

    if (!parsed.success || parsed.data.metadata.owner !== parentId) {
      continue;
    }

    const metadata = parsed.data.metadata;

    for (const nativeEntryId of metadata.matched) {
      members.push({ taskId: metadata.id, nativeEntryId, status: metadata.status, file });
    }
  }

  return members;
}

/** Compare source-level shadow decisions with exact recorded legacy memberships.
@param state - Proposed shadow checkpoint.
@param legacy - Explicit old memberships.
@returns Reviewable source-aligned comparison; unknowns stay inconclusive.
*/
export function shadowComparison(state: Ledger, legacy: LegacyMembership[]) {
  const rows = [];

  for (const source of legacy) {
    const eventId = `native:${source.nativeEntryId}`;
    const decision = latestDecision(state, eventId);

    rows.push({
      source: source.nativeEntryId,
      legacyTaskId: source.taskId,
      proposed: decision?.assignment ?? null,
      decisionId: decision?.id ?? null,
      diagnostic: decision
        ? "Compare task relationships and origin policy; task IDs can differ."
        : "Unresolved provenance.",
    });
  }

  return { version: 1, mode: state.mode, revision: state.revision, rows };
}

/** Run the new interpretation in shadow mode and save comparisons without changing legacy archives.
@param parentId - Authorized parent.
@param apiKey - Central classifier credential.
@param signal - New-input cancellation boundary.
@returns Shadow checkpoint and reviewable comparison.
*/
export async function shadowTaskPass(parentId: string, apiKey: string, signal?: AbortSignal) {
  if (readTaskLedger(parentId).mode !== "shadow") {
    throw new Error("Shadow classification requires a shadow ledger; the live ledger was not changed.");
  }

  const state = await classifyTaskLedger(parentId, apiKey, signal);
  const comparison = shadowComparison(state, await legacyMemberships(parentId));

  await writeTaskFile(taskDirectory(parentId), "routing-shadow.json", JSON.stringify(comparison, null, 2));

  return { state, comparison };
}
