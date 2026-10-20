import { type AdapterOptions, type HarnessAdapter, type HarnessMessage, type HarnessResult } from "./types";
import { CodexRpc, RpcError } from "../rpc";
import { type Item, type PendingRequest, type RpcEvent, object, string } from "../../lib/protocol";
import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "../rpc-events";
import { CodexAgents } from "./codex-agents";
import { type SessionResponse } from "../rpc-protocol";
import { codexParentTools } from "./mcp-config";
import { codexPermissions } from "./permissions";
import { harnessMessages } from "./transcript";
import { loadHistory } from "../history";
import { log } from "../logging";
import { sidePocketInstructions } from "./instructions";
import { validateAnswer } from "../answers";

const INVALID_REQUEST_CODE = -32_600;

/**
Classify native approval methods without treating unsupported requests as approvals.
@param method - Native server-request method.
@returns The approval or unsupported prompt category.
*/
function approvalKind(method: string) {
  return method.endsWith("requestApproval") ? "approval" : "unsupported";
}

/**
Extract Codex assistant text while preserving its existing array-content fallback.
@param item - Normalized native transcript item.
@returns Assistant text from the dedicated field or text content parts.
*/
function text(item: Item) {
  return (
    string(item.text) ||
    (Array.isArray(item.content)
      ? item.content
          .map((part) => string(object(part).text))
          .filter(Boolean)
          .join("\n")
      : "")
  );
}

/**
Own one delegated Codex session and its native turn, history and prompt lifecycle.
*/
export class CodexAdapter implements HarnessAdapter {
  private rpc = new CodexRpc();

  private sessionId?: string;

  private active?: string;

  private pending?: { resolve: (result: HarnessResult) => void; reject: (error: Error) => void };

  private outputs = new Map<string, string>();

  private nativeAgents = new CodexAgents();

  /**
  Subscribe to the delegated client's typed native transport events.
  @param options - Scoped child identity, inherited configuration and worker callbacks.
  */
  constructor(private options: AdapterOptions) {
    this.rpc.addEventListener("event", (event) => {
      if (event instanceof RpcNotificationEvent) {
        this.event(event.notification);
      }
    });
    this.rpc.addEventListener("diagnostic", (event) => {
      if (event instanceof RpcDiagnosticEvent) {
        log().debug({ message: event.text }, "side_pocket.codex.stderr");
      }
    });
    this.rpc.addEventListener("disconnect", (event) => {
      if (event instanceof RpcDisconnectEvent) {
        this.pending?.reject(event.error);
      }
    });
  }

  /**
  Track descendants before routing session-scoped prompts and turn output.
  @param event - Validated native event.
  */
  private event(event: RpcEvent) {
    const nativeAgents = this.nativeAgents.observe(event, this.sessionId);

    if (nativeAgents) {
      this.options.callbacks.metadata({ nativeAgents });
    }

    if (event.params.threadId && event.params.threadId !== this.sessionId) {
      return;
    }

    if (event.id !== undefined) {
      void this.answerRequest({ ...event, id: event.id }).catch((error: unknown) =>
        this.pending?.reject(error instanceof Error ? error : new Error("Harness request failed.", { cause: error }))
      );

      return;
    }

    switch (event.method) {
      case "item/completed": {
        const item = event.params.item;

        if (item?.type !== "agentMessage") {
          return;
        }

        this.outputs.set(item.id, text(item));
        this.options.callbacks.output(text(item));
        break;
      }

      case "turn/started": {
        this.active = event.params.turn?.id;
        break;
      }

      case "turn/completed": {
        const turn = event.params.turn;

        if (!turn) {
          break;
        }

        this.active = undefined;
        this.pending?.resolve({
          status: turn.status === "completed" || turn.status === "interrupted" ? turn.status : "failed",
          text:
            this.outputs.values().toArray().join("\n\n") ||
            (turn.error?.message.length ? turn.error.message : "No response text."),
        });
        break;
      }
    }
  }

  /**
  Obtain and validate the worker's answer before responding to a native prompt.
  @param request - Validated pending native request.
  */
  private async answerRequest(request: PendingRequest) {
    const kind = request.method === "item/tool/requestUserInput" ? "question" : approvalKind(request.method);
    const answer = await this.options.callbacks.request({
      id: String(request.id),
      kind,
      method: request.method,
      input: request.params,
    });

    this.rpc.respond(request.id, validateAnswer(request, answer));
  }

  /**
  Resume a saved child or replace only a known never-started empty session.
  @param params - Native session parameters including inherited permissions and instructions.
  @returns The validated native session response.
  */
  private async session(params: Record<string, unknown>): Promise<SessionResponse> {
    const { child } = this.options;

    if (!child.sessionId) {
      return this.rpc.request("thread/start", params);
    }

    try {
      return await this.rpc.request("thread/resume", { ...params, threadId: child.sessionId });
    } catch (error) {
      if (
        !(error instanceof RpcError) ||
        error.code !== INVALID_REQUEST_CODE ||
        child.sessionStarted !== false ||
        !error.message.startsWith("no rollout found for thread id ")
      ) {
        throw error;
      }

      // Codex does not persist an empty thread. Only replace a session known to have received no input.
      return this.rpc.request("thread/start", params);
    }
  }

  /**
  Read effective instructions before creating or resuming the native child.
  @returns The native child session identity.
  */
  private async restoreSession() {
    const { child, callbacks } = this.options;
    const { config: effective } = await this.rpc.request("config/read", {
      cwd: child.cwd,
      includeLayers: false,
    });
    const { thread, model, reasoningEffort } = await this.session({
      cwd: child.cwd,
      ...codexPermissions(child.policy),
      model: child.model ?? child.policy.model,
      developerInstructions: [string(effective.developer_instructions), sidePocketInstructions(child)]
        .filter(Boolean)
        .join("\n\n"),
      ephemeral: false,
    });

    this.sessionId = thread.id;
    callbacks.metadata({
      model,
      effort: child.effort ?? child.policy.effort ?? reasoningEffort,
      pid: this.rpc.pid,
      ...(thread.id !== child.sessionId && { sessionStarted: false }),
    });

    return thread.id;
  }

  /**
  Hold the pending turn result until completion or transport failure, then release it.
  @param id - Durable delegated command identity.
  @param input - Delegated user input.
  @returns The terminal native harness result.
  */
  private async runTurn(id: string, input: string) {
    const result = new Promise<HarnessResult>((resolve, reject) => {
      this.pending = { resolve, reject };
    });

    this.options.callbacks.metadata({ sessionStarted: true });

    try {
      this.startTurn(id, input);

      return await result;
    } finally {
      this.pending = undefined;
    }
  }

  /**
  Send the native turn and route acknowledgement failures to its pending result.
  @param id - Durable delegated command identity.
  @param input - Delegated user input.
  */
  private startTurn(id: string, input: string) {
    const { child } = this.options;
    const start = this.rpc.request("turn/start", {
      threadId: this.sessionId,
      clientUserMessageId: id,
      input: [{ type: "text", text: input, text_elements: [] }],
      effort: child.effort ?? child.policy.effort,
    });

    void start.catch((error: unknown) =>
      this.pending?.reject(error instanceof Error ? error : new Error("Harness request failed.", { cause: error }))
    );
  }

  /**
  Connect the native child before restoring its effective session.
  @returns The native child session identity.
  */
  async open() {
    const { config, child, callbacks, parentTools } = this.options;

    callbacks.metadata({ nativeAgents: null });
    await this.rpc.connect(
      {
        ...config,
        threadId: child.sessionId ?? child.id,
        cwd: child.cwd,
        serverArgs: [...config.serverArgs, ...codexParentTools(parentTools)],
      },
      "bare"
    );

    return this.restoreSession();
  }

  /**
  Clear prior output before beginning the next delegated command.
  @param id - Durable delegated command identity.
  @param input - Delegated user input.
  @returns The terminal native harness result.
  */
  async run(id: string, input: string) {
    this.outputs.clear();

    return this.runTurn(id, input);
  }

  /**
  Read complete native history and project canonical delegated messages.
  @returns Chronological normalized harness messages.
  */
  async history(): Promise<HarnessMessage[]> {
    const { thread } = await this.rpc.request("thread/read", {
      threadId: this.sessionId,
      includeTurns: true,
    });

    return harnessMessages(await loadHistory(this.rpc, thread));
  }

  /**
  Interrupt the current native turn when one is active.
  */
  async interrupt() {
    if (this.active) {
      await this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: this.active });
    }
  }

  /**
  Archive the delegated native session without creating another session.
  */
  async archive() {
    await this.rpc.request("thread/archive", { threadId: this.sessionId });
  }

  /**
  Terminate the native child and wait for process exit.
  */
  async close() {
    await this.rpc.shutdown();
  }
}
