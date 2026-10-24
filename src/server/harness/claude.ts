import { valueAfterCleanup, requireResults } from "../../lib/results";
import { t as captureResult } from "try";
import {
  type AdapterOptions,
  type HarnessAdapter,
  type HarnessMessage,
  type HarnessResult,
  type SteeringResult,
} from "./types";
import { type ChildProcess, spawn } from "node:child_process";
import {
  type Query,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  getSessionInfo,
  getSessionMessages,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeTranscript, harnessMessages, nativeText } from "../../state/harness-transcript";
import { type ClaudeAgentState, observedClaudeAgents, waitingClaudeAgent } from "../../state/claude-agents";
import {
  type ClaudeWriteState,
  restoredClaudeWrites,
  observedClaudeWrites,
  applyClaudeWrites,
} from "../../state/claude-writes";
import { claudeOptions } from "./claude-options";
import { claudePermissions } from "../../state/harness-permissions";
import { log } from "../logging";
import { waitForProcessExit } from "./process";
import { z } from "zod";

export { claudeOptions } from "./claude-options";

const messageIdSchema: z.ZodType<NonNullable<SDKUserMessage["uuid"]>> = z
  .uuid()
  .pipe(z.templateLiteral([z.string(), "-", z.string(), "-", z.string(), "-", z.string(), "-", z.string()]));

/** Keep one SDK input open until its query consumer has finished.
@param id - Validated native message identity.
@param text - Original delegated assignment.
@param finished - Explicit query-lifetime completion signal.
@yields The single owned native user message.
*/
async function* claudeInput(
  id: NonNullable<SDKUserMessage["uuid"]>,
  text: string,
  finished: Promise<undefined>
): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: id };
  await finished;
}

/**
Own one delegated Claude SDK session and its native process and query lifetimes.
*/
export class ClaudeAdapter implements HarnessAdapter {
  private sessionId: string;

  private resume: boolean;

  private current?: Query;

  private process?: ChildProcess;

  private interrupted = false;

  private nativeAgents: ClaudeAgentState = {};

  private writes: ClaudeWriteState;

  /** Publish native question ownership without mutating an earlier snapshot.
  @param nativeId - Known native task.
  @param isWaiting - Whether an answer is outstanding.
  */
  private readonly waiting = (nativeId: string, isWaiting: boolean) => {
    const nativeAgents = waitingClaudeAgent(this.nativeAgents, nativeId, isWaiting);

    if (!nativeAgents) {
      return;
    }

    this.nativeAgents = nativeAgents;
    this.options.callbacks.metadata({ nativeAgents });
  };

  /** Acquire the exact native process that this query must later join.
  @param options - SDK launch configuration.
  @returns Owned child process.
  */
  private readonly spawnProcess: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
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
  };

  /**
Retain a saved native session or allocate a new child identity.
@param options - Scoped child context, inherited policy and worker callbacks.
*/
  constructor(private options: AdapterOptions) {
    this.sessionId = options.child.sessionId ?? crypto.randomUUID();
    this.resume = !!options.child.sessionId;
    this.writes = restoredClaudeWrites(options.child.metadata);
  }

  /**
Publish native display metadata before forwarding assistant text.
@param message - Native SDK message from the owned query.
*/
  private event(message: SDKMessage) {
    log().debug({ childId: this.options.child.id, message }, "side_pocket.claude.event");

    this.publishNative(message);
    const writes = observedClaudeWrites(this.writes, this.sessionId, message);

    this.writes = writes.state;

    if (writes.patch) {
      this.options.callbacks.metadata(writes.patch);
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

    if (message.type === "assistant") {
      this.output(message);
    }
  }

  /**
Publish task lifecycle changes only when the SDK message concerns native agents.
@param message - Native SDK message from the owned query.
*/
  private publishNative(message: SDKMessage) {
    const nativeAgents = observedClaudeAgents(this.nativeAgents, message);

    if (!nativeAgents) {
      return;
    }

    this.nativeAgents = nativeAgents;
    this.options.callbacks.metadata({ nativeAgents });
  }

  /**
Forward nonempty native assistant text without changing its content.
@param message - Native SDK assistant message.
*/
  private output(message: SDKAssistantMessage) {
    const text = nativeText(message.message.content);

    if (text) {
      this.options.callbacks.output(text);
    }
  }

  /**
Normalize native terminal status while preserving an explicit interruption.
@param message - Native SDK terminal result message.
@returns The delegated harness result and native response text.
*/
  private result(message: SDKResultMessage): HarnessResult {
    const status = message.is_error ? "failed" : "completed";

    return {
      status: this.interrupted ? "interrupted" : status,
      text: message.subtype === "success" ? message.result : message.errors.join("\n"),
    };
  }

  /**
Consume the SDK query until a terminal result or an uncertain premature exit.
@param run - Owned native SDK query.
@returns The terminal delegated harness result.
*/
  private async consume(run: Query): Promise<HarnessResult> {
    for await (const message of run) {
      this.event(message);

      if (message.type === "system" && message.subtype === "init") {
        this.resume = true;
      }

      if (message.type === "result") {
        return this.result(message);
      }
    }

    throw new Error(
      "Claude exited without a turn result. Delivery may have occurred; inspect history before retrying."
    );
  }

  /**
Hold the SDK input stream open until query consumption and process cleanup finish.
@param id - Durable delegated command identity validated as the SDK UUID format.
@param text - Delegated user input.
@returns The terminal delegated harness result.
*/
  private async turn(id: string, text: string) {
    const finished = Promise.withResolvers<undefined>();
    const messageId = messageIdSchema.parse(id);
    const started = captureResult(query, {
      prompt: claudeInput(messageId, text, finished.promise),
      options: {
        ...claudeOptions(this.options, this.sessionId, this.resume, this.waiting),
        spawnClaudeCodeProcess: this.spawnProcess,
      },
    });

    this.current = started.ok ? started.value : undefined;
    const completed = started.ok ? await captureResult(this.consume.bind(this), started.value) : started;

    finished.resolve(undefined);
    const closed = captureResult(this.closeQuery.bind(this));
    const exited = await captureResult(waitForProcessExit, this.process);

    this.current = undefined;

    return valueAfterCleanup(
      completed,
      captureResult(requireResults, [closed, exited], "Claude query cleanup failed.")
    );
  }

  /**
  Release the current SDK iterator even after consumption failed.
  */
  private closeQuery() {
    this.current?.close();
  }

  /**
Validate inherited policy and discover whether the native saved session exists.
@returns The stable native child session identity.
*/
  async open() {
    claudePermissions(this.options.child.policy);
    this.resume = !!(await getSessionInfo(this.sessionId, { dir: this.options.child.cwd }));

    return this.sessionId;
  }

  /**
Reset per-turn state before submitting the next native SDK input.
@param id - Durable delegated command identity.
@param text - Delegated user input.
@returns The terminal delegated harness result.
*/
  async run(id: string, text: string): Promise<HarnessResult> {
    this.interrupted = false;
    this.nativeAgents = {};
    this.options.callbacks.metadata({ nativeAgents: null });

    return this.turn(id, text);
  }

  /**
Read SDK saved messages and project canonical delegated history.
@returns Chronological delegated messages from native saved history.
*/
  async history(): Promise<HarnessMessage[]> {
    const messages = await getSessionMessages(this.sessionId, { dir: this.options.child.cwd });

    return harnessMessages(applyClaudeWrites(claudeTranscript(messages), this.writes.saved, this.sessionId));
  }

  /**
Reject unsupported conditional steering without submitting a potentially queued SDK message.
@returns Explicit unsupported outcome; no native message was sent.
*/
  steer(): Promise<SteeringResult> {
    return Promise.resolve({
      status: "unsupported",
      detail:
        "Claude streaming input can queue a later turn; no supported expected-turn steering contract is available. Nothing was sent.",
    });
  }

  /**
Mark the current turn interrupted before invoking the native SDK interrupt operation.
*/
  async interrupt() {
    this.interrupted = true;
    await this.current?.interrupt();
  }

  /**
Interrupt the native query while Pocket retains the resumable saved session.
*/
  async archive() {
    // Claude has no native archive operation. Pocket archives its own record and keeps resumable history.
    await this.interrupt();
  }

  /**
Close the owned SDK query and await its native process exit.
*/
  async close() {
    const closed = captureResult(this.closeQuery.bind(this));
    const exited = await captureResult(waitForProcessExit, this.process);

    requireResults([closed, exited], "Claude query shutdown failed.");
  }
}
