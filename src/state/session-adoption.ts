import { type Thread, object, string } from "../lib/protocol";
import { activeNativeTurn } from "./harness-result";
import { delegationKey } from "./delegation-input";
import { z } from "zod";

export const socketPath = z
  .string()
  .startsWith("/")
  .refine((value) => !/[:\r\n\0]/u.test(value), "Invalid socket path");
export const adoptionInput = z
  .object({
    threadId: z.string().min(1),
    title: delegationKey,
    idempotencyKey: delegationKey,
    socketPath: socketPath.optional(),
  })
  .strict();
export const sessionListInput = z
  .object({
    cursor: z.string().optional(),
    archived: z.boolean().default(false),
    search: z.string().optional(),
    socketPath: socketPath.optional(),
  })
  .strict();

export type AdoptionInput = z.infer<typeof adoptionInput>;
export interface AdoptedSession {
  threadId: string;
  cwd: string;
  turnId?: string;
}
export const attachmentSchema = z.object({
  socketPath,
  turnId: z.string().optional(),
  watchCommandId: z.string().optional(),
});

export type SessionAttachment = z.infer<typeof attachmentSchema>;

/**
Read persisted attachment metadata without trusting unchecked JSON fields.
@param metadata - Persisted child metadata.
@returns Validated live attachment, or undefined for ordinary saved children.
*/
export function sessionAttachment(metadata: string) {
  return attachmentSchema.optional().parse(object(JSON.parse(metadata)).attachment);
}

/**
Reject active saved copies and retain the exact native identity and working folder.
@param thread - Native persisted or loaded session.
@param isLive - Whether the caller selected the owning server.
@returns Metadata needed for durable adoption.
*/
export function inspectedSession(thread: Thread, isLive: boolean): AdoptedSession {
  const active = activeNativeTurn(thread.turns, new Map());
  const cwd = string(thread.cwd);

  if (!cwd.startsWith("/")) {
    throw new Error("The existing session has no absolute working directory.");
  }

  if (!isLive && (active || object(thread.status).type === "active")) {
    throw new Error("This session may still be running. Supply its owning app-server socketPath to attach live.");
  }

  return { threadId: thread.id, cwd, ...(active && { turnId: active }) };
}
