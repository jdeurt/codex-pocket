import type { AdapterOptions, HarnessAdapter, HarnessMessage, HarnessResult } from "./types";
import { type ChildProcess, spawn } from "node:child_process";
import {
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  getSessionInfo,
  getSessionMessages,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeTranscript, harnessMessages } from "./transcript";
import { object, string } from "../../lib/protocol";
import { claudePermissions } from "./permissions";
import { log } from "../logging";
import { requireClaudeBinary } from "./claude-binary";
import { sidePocketInstructions } from "./instructions";
import { waitForProcessExit } from "./process";
import { z } from "zod";

const HOOK_TIMEOUT_SECONDS = 3600;
const questionsAnswer = z.object({ answers: z.record(z.string(), z.string()) }).strict();

export function claudeOptions(
  options: AdapterOptions,
  sessionId: string,
  resume: boolean,
  nativeRequest?: (id: string, waiting: boolean) => void
): Options {
  const { child, callbacks, parentTools } = options;
  const inheritedEffort = child.effort ?? child.policy.effort;
  const effort = inheritedEffort === "minimal" ? "low" : inheritedEffort;

  return {
    ...claudePermissions(child.policy),
    cwd: child.cwd,
    ...(resume ? { resume: sessionId } : { sessionId }),
    ...((child.model ?? process.env.POCKET_CLAUDE_MODEL) && { model: child.model ?? process.env.POCKET_CLAUDE_MODEL }),
    ...(effort && { effort: z.enum(["low", "medium", "high", "xhigh", "max"]).parse(effort) }),
    pathToClaudeCodeExecutable: requireClaudeBinary(),
    systemPrompt: { type: "preset", preset: "claude_code", append: sidePocketInstructions(child) },
    title: `Side Pocket: ${child.title}`,
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    strictMcpConfig: true,
    mcpServers: parentTools ? { pocket_parent: { type: "stdio", ...parentTools } } : {},
    persistSession: true,
    stderr: (message) => log().debug({ message, childId: child.id }, "side_pocket.claude.stderr"),
    hooks: {
      PermissionRequest: [
        {
          timeout: HOOK_TIMEOUT_SECONDS,
          hooks: [
            async (input) => {
              if (input.hook_event_name !== "PermissionRequest") {
                return {};
              }

              const data = object(input.tool_input);
              const question = input.tool_name === "AskUserQuestion";

              if (question && input.agent_id) {
                nativeRequest?.(input.agent_id, true);
              }

              const updatedInput = question
                ? {
                    ...data,
                    ...questionsAnswer.parse(
                      await callbacks.request({
                        id: crypto.randomUUID(),
                        kind: "question",
                        method: input.tool_name,
                        input: data,
                      })
                    ),
                  }
                : data;

              if (question && input.agent_id) {
                nativeRequest?.(input.agent_id, false);
              }

              return {
                hookSpecificOutput: {
                  hookEventName: "PermissionRequest",
                  decision: { behavior: "allow", updatedInput },
                },
              };
            },
          ],
        },
      ],
    },
  };
}

function messageText(content: unknown) {
  return Array.isArray(content)
    ? content
        .map((part) => string(object(part).text))
        .filter(Boolean)
        .join("\n")
    : string(content);
}

export class ClaudeAdapter implements HarnessAdapter {
  private sessionId: string;
  private resume: boolean;
  private current?: Query;
  private process?: ChildProcess;
  private interrupted = false;
  private nativeAgents: Record<string, { name: string; status: string; parentId?: string; background?: boolean }> = {};
  constructor(private options: AdapterOptions) {
    this.sessionId = options.child.sessionId ?? crypto.randomUUID();
    this.resume = !!options.child.sessionId;
  }
  private event(message: SDKMessage) {
    log().debug({ childId: this.options.child.id, message }, "side_pocket.claude.event");

    // Persist only native lifecycle display metadata, never task prompts or inputs.
    if (
      message.type === "system" &&
      ["task_started", "task_updated", "task_notification", "background_tasks_changed"].includes(message.subtype)
    ) {
      if (message.subtype === "task_started" && message.task_type === "local_agent" && !message.ambient) {
        this.nativeAgents[message.task_id] = {
          name: message.description,
          status: "running",
          parentId: message.parent_task_id,
          background: message.is_backgrounded,
        };
      } else if (message.subtype === "task_updated" && Object.hasOwn(this.nativeAgents, message.task_id)) {
        if (message.patch.is_backgrounded !== undefined) {
          this.nativeAgents[message.task_id].background = message.patch.is_backgrounded;
        }

        const status = message.patch.status;

        if (status) {
          this.nativeAgents[message.task_id].status =
            status === "paused"
              ? "unknown"
              : status === "killed"
                ? "closed"
                : status === "pending"
                  ? "unknown"
                  : status;
        }
      } else if (message.subtype === "task_notification" && Object.hasOwn(this.nativeAgents, message.task_id)) {
        this.nativeAgents[message.task_id].status = message.status === "stopped" ? "closed" : message.status;
      } else if (message.subtype === "background_tasks_changed") {
        for (const task of Object.values(this.nativeAgents)) {
          if (task.background && task.status === "running") {
            task.status = "unknown";
          }
        }

        for (const task of message.tasks) {
          if (task.task_type === "local_agent" && !task.ambient) {
            this.nativeAgents[task.task_id] = {
              name: task.description,
              status: "running",
              parentId: task.parent_task_id,
              background: true,
            };
          }
        }
      }

      this.options.callbacks.metadata({ nativeAgents: this.nativeAgents });
    }

    if (message.type === "system" && message.subtype === "init") {
      this.options.callbacks.metadata({
        model: message.model,
        effort: message.effort ?? this.options.child.effort ?? this.options.child.policy.effort,
        tools: message.tools,
        servers: message.mcp_servers,
        permissionMode: message.permissionMode,
      });
    }

    if (message.type !== "assistant") {
      return;
    }

    const text = messageText(message.message.content);

    if (text) {
      this.options.callbacks.output(text);
    }
  }
  private async consume(run: Query): Promise<HarnessResult> {
    for await (const message of run) {
      this.event(message);

      if (message.type === "system" && message.subtype === "init") {
        this.resume = true;
      }

      if (message.type === "result") {
        return {
          status: this.interrupted ? "interrupted" : message.is_error ? "failed" : "completed",
          text: message.subtype === "success" ? message.result : message.errors.join("\n"),
        };
      }
    }

    throw new Error(
      "Claude exited without a turn result. Delivery may have occurred; inspect history before retrying."
    );
  }
  async open() {
    claudePermissions(this.options.child.policy);
    this.resume = !!(await getSessionInfo(this.sessionId, { dir: this.options.child.cwd }));

    return this.sessionId;
  }
  async run(id: string, text: string): Promise<HarnessResult> {
    this.interrupted = false;
    this.nativeAgents = {};
    this.options.callbacks.metadata({ nativeAgents: null });
    const finished = Promise.withResolvers<undefined>();
    const input = async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: text },
        parent_tool_use_id: null,
        uuid: id as SDKUserMessage["uuid"],
      };
      await finished.promise;
    };
    const run = query({
      prompt: input(),
      options: {
        ...claudeOptions(this.options, this.sessionId, this.resume, (nativeId, waiting) => {
          if (!Object.hasOwn(this.nativeAgents, nativeId)) {
            return;
          }

          this.nativeAgents[nativeId].status = waiting ? "waiting" : "running";
          this.options.callbacks.metadata({ nativeAgents: this.nativeAgents });
        }),
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: { NODE_ENV: process.env.NODE_ENV, ...options.env },
            signal: options.signal,
            stdio: "pipe",
            shell: false,
          });
          this.process = child;
          this.options.callbacks.metadata({ pid: child.pid });

          return child;
        },
      },
    });
    this.current = run;

    try {
      return await this.consume(run);
    } finally {
      finished.resolve(undefined);
      run.close();
      await waitForProcessExit(this.process);
      this.current = undefined;
    }
  }
  async history(): Promise<HarnessMessage[]> {
    const messages = await getSessionMessages(this.sessionId, { dir: this.options.child.cwd });

    return harnessMessages(claudeTranscript(messages));
  }
  async interrupt() {
    this.interrupted = true;
    await this.current?.interrupt();
  }
  async archive() {
    // Claude has no native archive operation. Pocket archives its own record and keeps resumable history.
    await this.interrupt();
  }
  async close() {
    this.current?.close();
    await waitForProcessExit(this.process);
  }
}
