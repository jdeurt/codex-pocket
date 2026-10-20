import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const baseInstructionsSchema = z.object({ text: z.string() });
const contentPartSchema = z.object({ text: z.string().optional() });
const payloadSchema = z.object({
  base_instructions: baseInstructionsSchema.optional(),
  role: z.string().optional(),
  content: z.array(contentPartSchema).default([]),
});
const rolloutRowSchema = z.object({ type: z.string(), payload: payloadSchema });

type RolloutRow = z.infer<typeof rolloutRowSchema>;

/**
Requires native session metadata and selects developer text from the already normalized saved rows.
@param metadata - Native session metadata row, when present in the saved rollout.
@param rows - Validated native rollout rows in original order.
@returns Native base instructions and chronological developer instruction text.
*/
function instructions(metadata: RolloutRow | undefined, rows: RolloutRow[]) {
  assert.ok(metadata?.payload.base_instructions);

  return {
    base: metadata.payload.base_instructions.text,
    developerTexts: rows
      .filter((row) => row.type === "response_item" && row.payload.role === "developer")
      .flatMap((row) => row.payload.content)
      .map((part) => part.text ?? ""),
  };
}

/**
Reads the actual native saved rollout and validates each newly read JSON row once.
@param filename - Native saved-session path acknowledged by the app-server.
@returns Required native base and developer instruction records for the audit.
*/
export async function readInstructionRollout(filename: string) {
  const content = await readFile(filename, "utf8");
  const rows = content
    .trim()
    .split("\n")
    .map((line) => rolloutRowSchema.parse(JSON.parse(line)));
  const metadata = rows.find((row) => row.type === "session_meta");

  return instructions(metadata, rows);
}
