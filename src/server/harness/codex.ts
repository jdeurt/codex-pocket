import { SIDE_PROMPTS } from "../pocket-prompts";
import { codexResult } from "../../state/harness-result";
import { restoreCodexThread } from "./codex-session";
import { t as captureResult } from "try";
import {
  type AdapterOptions,
  type HarnessAdapter,
  type HarnessMessage,
  type HarnessResult,
  type SteeringResult,
} from "./types";
import { CodexRpc } from "../rpc";
import { type Item, type PendingRequest, type RpcEvent, string } from "../../lib/protocol";
import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "../rpc-events";
import { harnessMessages, nativeText } from "../../state/harness-transcript";
import { type CodexAgentState, observedCodexAgents } from "../../state/codex-agents";
import { codexParentTools } from "./mcp-config";
import { codexPermissions } from "../../state/harness-permissions";
import { loadHistory } from "../history";
import { log } from "../logging";
import { sidePocketInstructions } from "../../state/harness-instructions";
import { steerCodex } from "./codex-steering";
import { validateAnswer } from "../../state/answers";
import { observeDelegateCost } from "../cost-tracking";

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
  return string(item.text) || (Array.isArray(item.content) ? nativeText(item.content) : "");
}

/**
Own one delegated Codex session and its native turn, history and prompt lifecycle.
*/
export class CodexAdapter implements HarnessAdapter {
  private rpc = new CodexRpc();

  private sessionId?: string;
  private model = "unknown";

  private active?: string;

  private started?: Promise<unknown>;

  private completed = false;

  private pending?: { resolve: (result: HarnessResult) => void; reject: (error: Error) => void };

  private outputs = new Map<string, string>();

  private nativeAgents: CodexAgentState = {};

  /** Route the owned native event event.
  @param event - Typed transport notification.
  */
  private readonly receivedEvent = (event: Event) => {
    if (event instanceof RpcNotificationEvent) {
      this.event(event.notification);
    }
  };

  /** Route the owned native diagnostic event.
  @param event - Typed transport notification.
  */
  private readonly receivedDiagnostic = (event: Event) => {
    if (event instanceof RpcDiagnosticEvent) {
      log().debug({ message: event.text }, "side_pocket.codex.stderr");
    }
  };

  /** Route the owned native disconnect event.
  @param event - Typed transport notification.
  */
  private readonly receivedDisconnect = (event: Event) => {
    if (event instanceof RpcDisconnectEvent) {
      this.pending?.reject(event.error);
    }
  };

  /**
  Subscribe to the delegated client's typed native transport events.
  @param options - Scoped child identity, inherited configuration and worker callbacks.
  */
  constructor(private options: AdapterOptions) {
    this.rpc.addEventListener("event", this.receivedEvent);
    this.rpc.addEventListener("diagnostic", this.receivedDiagnostic);
    this.rpc.addEventListener("disconnect", this.receivedDisconnect);
  }

  /**
  Track descendants before routing session-scoped prompts and turn output.
  @param event - Validated native event.
  */
  private event(event: RpcEvent) {
    const nativeAgents = observedCodexAgents(this.nativeAgents, event, this.sessionId);

    if (nativeAgents) {
      this.nativeAgents = nativeAgents;
      this.options.callbacks.metadata({ nativeAgents });
    }

    if (event.params.threadId && event.params.threadId !== this.sessionId) {
      return;
    }

    observeDelegateCost(this.options, event, this.sessionId ?? "unknown", this.model);

    if (event.id !== undefined) {
      void this.settleRequest(this.answerRequest({ ...event, id: event.id }));

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

        if (!turn || turn.id !== this.active) {
          break;
        }

        this.completed = true;
        this.active = undefined;
        this.pending?.resolve(codexResult(turn, this.outputs));
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
  Read effective instructions before creating or resuming the native child.
  @returns The native child session identity.
  */
  private async restoreSession() {
    const { child, callbacks } = this.options;
    const { config: effective } = await this.rpc.request("config/read", {
      cwd: child.cwd,
      includeLayers: false,
    });
    const { thread, model, reasoningEffort } = await restoreCodexThread(this.rpc, child, {
      cwd: child.cwd,
      ...codexPermissions(child.policy),
      model: child.model ?? child.policy.model,
      developerInstructions: [string(effective.developer_instructions), sidePocketInstructions(child, SIDE_PROMPTS)]
        .filter(Boolean)
        .join("\n\n"),
      ephemeral: false,
    });

    this.sessionId = thread.id;
    this.model = model;
    callbacks.metadata({
      model,
      effort: child.effort ?? child.policy.effort ?? reasoningEffort,
      pid: this.rpc.pid,
      ...(thread.id !== child.sessionId && { sessionStarted: false }),
    });

    return thread.id;
  }

  /** Reject the owned turn when a native request fails.
  @param request - Pending start or question-response operation.
  */
  private async settleRequest(request: Promise<unknown>) {
    const result = await captureResult(request);

    if (!result.ok) {
      this.pending?.reject(
        result.error instanceof Error ? result.error : new Error("Harness request failed.", { cause: result.error })
      );
    }
  }

  /**
  Hold the pending turn result until completion or transport failure, then release it.
  @param id - Durable delegated command identity.
  @param input - Delegated user input.
  @returns The terminal native harness result.
  */
  private async runTurn(id: string, input: string) {
    const pending = Promise.withResolvers<HarnessResult>();

    this.pending = pending;

    this.options.callbacks.metadata({ sessionStarted: true });

    this.started = this.startTurn(id, input);
    void this.settleRequest(this.started);

    const completed = await captureResult(pending.promise);

    this.pending = undefined;

    if (!completed.ok) {
      throw completed.error;
    }

    return completed.value;
  }

  /**
  Send the native turn and route acknowledgement failures to its pending result.
  @param id - Durable delegated command identity.
  @param input - Delegated user input.
  */
  private async startTurn(id: string, input: string) {
    const { child } = this.options;
    const { turn } = await this.rpc.request("turn/start", {
      threadId: this.sessionId,
      clientUserMessageId: id,
      input: [{ type: "text", text: input, text_elements: [] }],
      effort: child.effort ?? child.policy.effort,
    });

    if (!this.completed) {
      this.active = turn.id;
    }
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
    this.completed = false;

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
  Wait for the native turn identity before conditionally steering that exact turn.
  @param id - Durable message identity reused for native correlation.
  @param input - Current-task correction, without turn-level option overrides.
  @returns Native acceptance or an explicit non-delivery or uncertain outcome.
  */
  async steer(id: string, input: string): Promise<SteeringResult> {
    await this.started;

    return steerCodex(this.rpc, this.sessionId, this.active, id, input);
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
