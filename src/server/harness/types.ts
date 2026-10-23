import type { Data, Item } from "../../lib/protocol";
import type { Config } from "../config";
import type { SessionAttachment } from "../session-adoption";

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
  sessionStarted?: boolean;
  /**
  Persisted delegation metadata, including the verified adoption marker.
  */
  metadata?: string;
  model?: string | null;
  effort?: string | null;
  policy: ParentPolicy;
  attachment?: SessionAttachment;
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
  role: "user" | "assistant" | "tool";
  text: string;
  item?: Item;
}
export interface HarnessCallbacks {
  request: (request: HarnessRequest) => Promise<unknown>;
  output: (text: string) => void;
  metadata: (data: Data) => void;
}
export type SteeringResult =
  { status: "accepted"; turnId: string } | { status: "idle" | "unsupported" | "failed" | "unknown"; detail: string };

export interface HarnessAdapter {
  open(): Promise<string>;
  run(id: string, text: string): Promise<HarnessResult>;
  watch?(turnId: string): Promise<HarnessResult>;
  steer(id: string, text: string): Promise<SteeringResult>;
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
  codex: {
    steering: "Native turn/steer with expectedTurnId; acknowledgement confirms acceptance, not consumption",
    savedSessions: true,
    adoption: "Existing saved Codex threads; live attachment requires the owning app-server Unix socket",
    queuedFollowups: true,
    interrupt: true,
    questions: true,
    permissions: "native",
  },
  claude: {
    steering:
      "Unsupported: the installed public SDK has no conditional active-turn steering acknowledgement. Streaming input can queue a later turn.",
    savedSessions: true,
    queuedFollowups: true,
    interrupt: true,
    questions: true,
    permissions: "Requires parent danger-full-access / never; other mappings are rejected",
    effort: "Inherits parent effort; minimal maps to low. Model defaults to Claude's configured model.",
  },
} as const;
