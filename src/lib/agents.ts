import { type Snapshot, snapshotSchema } from "./protocol";
import { z } from "zod";

export type AgentStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "closed" | "unknown";
export interface AgentEntry {
  id: string;
  parentId: string;
  name: string;
  source: "side-pocket" | "native";
  harness: "codex" | "claude";
  status: AgentStatus;
  preview: string;
  previewState?: "loading" | "empty" | "unavailable";
  model?: string;
  reasoningEffort?: string | null;
}
export interface AgentCatalog {
  agents: AgentEntry[];
  warnings: string[];
  updatedAt: number;
}
export interface AgentTranscript {
  agent: AgentEntry;
  state: Snapshot;
  history: "available" | "empty" | "unavailable";
  warning?: string;
  updatedAt: number;
}
export const agentStatusSchema = z.enum(["running", "waiting", "idle", "completed", "failed", "closed", "unknown"]);
export const agentEntrySchema = z.object({
  id: z.string(),
  parentId: z.string(),
  name: z.string(),
  source: z.enum(["side-pocket", "native"]),
  harness: z.enum(["codex", "claude"]),
  status: agentStatusSchema,
  preview: z.string(),
  previewState: z.enum(["loading", "empty", "unavailable"]).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
}) satisfies z.ZodType<AgentEntry>;
export const agentCatalogSchema = z.object({
  agents: z.array(agentEntrySchema),
  warnings: z.array(z.string()),
  updatedAt: z.number(),
}) satisfies z.ZodType<AgentCatalog>;
export const agentTranscriptSchema = z.object({
  agent: agentEntrySchema,
  state: snapshotSchema,
  history: z.enum(["available", "empty", "unavailable"]),
  warning: z.string().optional(),
  updatedAt: z.number(),
}) satisfies z.ZodType<AgentTranscript>;
export const activeAgent = (agent: AgentEntry) => agent.status === "running" || agent.status === "waiting";
export const agentSource = (agent: AgentEntry) =>
  `${agent.source === "side-pocket" ? "Side Pocket" : "Native agent"} · ${agent.harness === "codex" ? "Codex" : "Claude Code"}`;
export const agentStatus = (status: AgentStatus) =>
  ({
    running: "Running",
    waiting: "Waiting for input",
    idle: "Idle",
    completed: "Completed",
    failed: "Failed",
    closed: "Closed",
    unknown: "Status unavailable",
  })[status];
