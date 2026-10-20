import { type FileAttachment, fileAttachmentSchema } from "./attachments";
import { z } from "zod";

// Forward-compatible subset of Codex app-server v2, checked against CLI 0.163.
// Unknown item fields are preserved so newer CLI output remains inspectable.

export type Data = Record<string, unknown>;
export type Item = Data & {
  id: string;
  type: string;
  attachments?: FileAttachment[];
  images?: { source: string; alt?: string }[];
};
export interface Turn {
  id: string;
  status: string;
  items: Item[];
  itemsView?: string;
  error?: { message: string } | null;
}
export interface Thread extends Data {
  id: string;
  name?: string | null;
  preview?: string;
  turns: Turn[];
}
export interface RpcEvent {
  method: string;
  params: Data & { turn?: Turn; item?: Item };
  id?: string | number;
}
export type PendingRequest = RpcEvent & { id: string | number };
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  status: "queued" | "sending" | "unknown" | "sent";
}
export interface RestartEvent {
  id: string;
  threadId: string;
  after: { turnId: string; itemId: string };
}
export interface Snapshot {
  connection: "unconfigured" | "connecting" | "connected" | "disconnected";
  title: string;
  model?: string;
  reasoningEffort?: string | null;
  threadId?: string;
  activeTurnId?: string;
  activity?: string;
  turns: Turn[];
  restartEvents?: RestartEvent[];
  queue: QueuedMessage[];
  requests: PendingRequest[];
  notices: { id: string; title: string; detail: string }[];
  scheduled: Record<string, { title: string; scheduledAt: number }>;
  error?: string;
}
export const initialSnapshot: Snapshot = {
  connection: "connecting",
  title: "Pocket",
  turns: [],
  queue: [],
  requests: [],
  notices: [],
  scheduled: {},
};
export function isData(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function object(value: unknown): Data {
  return isData(value) ? value : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function pretty(value: unknown): string {
  return z
    .string()
    .catch("")
    .parse(JSON.stringify(value, null, 2));
}

export const dataSchema = z.record(z.string(), z.unknown());
export const itemSchema: z.ZodType<Item> = z.looseObject({
  id: z.string(),
  type: z.string(),
  attachments: z.array(fileAttachmentSchema).optional(),
  images: z.array(z.object({ source: z.string(), alt: z.string().optional() })).optional(),
});
export const turnSchema: z.ZodType<Turn> = z.looseObject({
  id: z.string(),
  status: z.string(),
  items: z.array(itemSchema).default([]),
  itemsView: z.string().optional(),
  error: z.looseObject({ message: z.string() }).nullable().optional(),
});
export const threadSchema: z.ZodType<Thread> = z.looseObject({
  id: z.string(),
  name: z.string().nullable().optional(),
  preview: z.string().optional(),
  turns: z.array(turnSchema).default([]),
});
export const rpcEventSchema = z.object({
  method: z.string(),
  params: z.looseObject({ turn: turnSchema.optional(), item: itemSchema.optional() }).default({}),
  id: z.union([z.string(), z.number()]).optional(),
}) satisfies z.ZodType<RpcEvent>;
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  attachments: z.array(fileAttachmentSchema).optional(),
  status: z.enum(["queued", "sending", "unknown", "sent"]),
});
export const restartEventSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  after: z.object({ turnId: z.string(), itemId: z.string() }),
});
export const pendingRequestSchema = rpcEventSchema.extend({ id: z.union([z.string(), z.number()]) });
export const snapshotSchema: z.ZodType<Snapshot> = z.object({
  connection: z.enum(["unconfigured", "connecting", "connected", "disconnected"]),
  title: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  threadId: z.string().optional(),
  activeTurnId: z.string().optional(),
  activity: z.string().optional(),
  turns: z.array(turnSchema),
  restartEvents: z.array(restartEventSchema).optional(),
  queue: z.array(queuedMessageSchema),
  requests: z.array(pendingRequestSchema),
  notices: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string() })),
  scheduled: z.record(z.string(), z.object({ title: z.string(), scheduledAt: z.number() })),
  error: z.string().optional(),
});
