import type { Config } from "../config";
import type { Data } from "../../lib/protocol";

export type Harness = "codex" | "claude";
export interface ParentPolicy {
  sandbox: string;
  approval: unknown;
  model?: string;
  effort?: string | null;
  workspace?: Data;
}
export interface ChildContext {
  id: string;
  parentId: string;
  title: string;
  cwd: string;
  sessionId?: string | null;
  model?: string | null;
  effort?: string | null;
  policy: ParentPolicy;
}
export interface HarnessRequest {
  id: string;
  kind: "question" | "approval" | "unsupported";
  method: string;
  input: Data;
}
export interface HarnessResult {
  status: "completed" | "interrupted" | "failed";
  text: string;
}
export interface HarnessMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}
export interface HarnessCallbacks {
  request: (request: HarnessRequest) => Promise<unknown>;
  output: (text: string) => void;
  metadata: (data: Data) => void;
}
export interface HarnessAdapter {
  open(): Promise<string>;
  run(id: string, text: string): Promise<HarnessResult>;
  history(): Promise<HarnessMessage[]>;
  interrupt(): Promise<void>;
  archive(): Promise<void>;
  close(): Promise<void>;
}
export interface AdapterOptions {
  config: Config;
  child: ChildContext;
  callbacks: HarnessCallbacks;
  parentTools?: { command: string; args: string[]; env: Record<string, string> };
}

export const harnessCapabilities = {
  codex: { savedSessions: true, queuedFollowups: true, interrupt: true, questions: true, permissions: "native" },
  claude: {
    savedSessions: true,
    queuedFollowups: true,
    interrupt: true,
    questions: true,
    permissions: "Requires parent danger-full-access / never; other mappings are rejected",
    effort: "Inherits parent effort; minimal maps to low. Model defaults to Claude's configured model.",
  },
} as const;
