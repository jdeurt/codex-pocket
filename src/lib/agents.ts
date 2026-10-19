import type { Snapshot } from "./protocol";

export type AgentStatus = "running" | "waiting" | "idle" | "completed" | "failed" | "closed" | "unknown";
export interface AgentEntry {
  id: string;
  parentId: string;
  name: string;
  source: "side-pocket" | "native";
  harness: "codex" | "claude";
  status: AgentStatus;
  preview: string;
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
