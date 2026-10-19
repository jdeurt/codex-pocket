// Forward-compatible subset of Codex app-server v2, checked against CLI 0.163.
// Unknown item fields are preserved so newer CLI output remains inspectable.
import type { FileAttachment } from "./attachments";
export type Data = Record<string, unknown>;
export type Item = Data & { id: string; type: string };
export interface Turn {
  id: string;
  status: string;
  items: Item[];
  itemsView?: string;
  error?: { message: string } | null;
}
export interface Thread {
  id: string;
  name?: string | null;
  preview?: string;
  turns: Turn[];
}
export interface RpcEvent {
  method: string;
  params: Data;
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
export function object(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}
