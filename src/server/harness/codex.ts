import { type AdapterOptions, type HarnessAdapter, type HarnessMessage, type HarnessResult } from "./types";
import { CodexRpc, RpcError } from "../rpc";
import { type Item, type PendingRequest, type RpcEvent, type Thread, object, string } from "../../lib/protocol";
import { codexParentTools } from "./mcp-config";
import { codexPermissions } from "./permissions";
import { harnessMessages } from "./transcript";
import { loadHistory } from "../history";
import { log } from "../logging";
import { sidePocketInstructions } from "./instructions";
import { validateAnswer } from "../answers";

const INVALID_REQUEST_CODE = -32_600;
interface SessionResponse {
  thread: Thread;
  model: string;
  reasoningEffort: string | null;
}

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

export class CodexAdapter implements HarnessAdapter {
  private rpc = new CodexRpc();
  private sessionId?: string;
  private active?: string;
  private pending?: { resolve: (result: HarnessResult) => void; reject: (error: Error) => void };
  private outputs = new Map<string, string>();
  private nativeAgents: Record<string, { parentId: string; name: string; status: string }> = {};
  constructor(private options: AdapterOptions) {
    this.rpc.on("event", (event: RpcEvent) => {
      this.event(event);
    });
    this.rpc.on("diagnostic", (message: string) => {
      log().debug({ message }, "side_pocket.codex.stderr");
    });
    this.rpc.on("disconnect", (error: Error) =>
      this.pending?.reject(error instanceof Error ? error : new Error("Harness request failed.", { cause: error }))
    );
  }
  private observeNative(event: RpcEvent) {
    if (
      ![
        "thread/started",
        "thread/status/changed",
        "turn/completed",
        "thread/closed",
        "thread/archived",
        "thread/deleted",
      ].includes(event.method)
    ) {
      return;
    }

    const thread = object(event.params.thread);
    const id = string(thread.id) || string(event.params.threadId);
    const parentId =
      string(thread.parentThreadId) ||
      string(object(object(object(thread.source).subAgent).thread_spawn).parent_thread_id);

    if (
      event.method === "thread/started" &&
      parentId &&
      (parentId === this.sessionId || Object.hasOwn(this.nativeAgents, parentId))
    ) {
      this.nativeAgents[id] = {
        parentId,
        name: string(thread.name) || string(thread.agentNickname),
        status: "unknown",
      };
    }

    if (!Object.hasOwn(this.nativeAgents, id)) {
      return;
    }

    if (event.method === "thread/status/changed" || event.method === "thread/started") {
      const status = object(event.params.status ?? thread.status);
      this.nativeAgents[id].status =
        status.type === "active"
          ? Array.isArray(status.activeFlags) && status.activeFlags.length > 0
            ? "waiting"
            : "running"
          : status.type === "idle"
            ? "idle"
            : status.type === "systemError"
              ? "failed"
              : "unknown";
    } else if (["thread/closed", "thread/archived", "thread/deleted"].includes(event.method)) {
      this.nativeAgents[id].status = "closed";
    } else if (event.method === "turn/completed") {
      const status = string(object(event.params.turn).status);
      this.nativeAgents[id].status = status === "completed" ? "completed" : status === "failed" ? "failed" : "idle";
    }

    this.options.callbacks.metadata({ nativeAgents: this.nativeAgents });
  }
  private event(event: RpcEvent) {
    this.observeNative(event);

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
          status: turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : "failed",
          text:
            this.outputs.values().toArray().join("\n\n") ||
            (turn.error?.message.length ? turn.error.message : "No response text."),
        });
        break;
      }
    }
  }
  private async answerRequest(request: PendingRequest) {
    const question = request.method === "item/tool/requestUserInput";
    const answer = await this.options.callbacks.request({
      id: String(request.id),
      kind: question ? "question" : request.method.endsWith("requestApproval") ? "approval" : "unsupported",
      method: request.method,
      input: request.params,
    });
    this.rpc.respond(request.id, validateAnswer(request, answer));
  }
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
  async run(id: string, input: string) {
    this.outputs.clear();
    const result = new Promise<HarnessResult>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const { child } = this.options;
    this.options.callbacks.metadata({ sessionStarted: true });

    try {
      const start = this.rpc.request("turn/start", {
        threadId: this.sessionId,
        clientUserMessageId: id,
        input: [{ type: "text", text: input, text_elements: [] }],
        effort: child.effort ?? child.policy.effort,
      });
      void start.catch((error: unknown) =>
        this.pending?.reject(error instanceof Error ? error : new Error("Harness request failed.", { cause: error }))
      );

      return await result;
    } finally {
      this.pending = undefined;
    }
  }
  async history(): Promise<HarnessMessage[]> {
    const { thread } = await this.rpc.request("thread/read", {
      threadId: this.sessionId,
      includeTurns: true,
    });

    return harnessMessages(await loadHistory(this.rpc, thread));
  }
  async interrupt() {
    if (this.active) {
      await this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: this.active });
    }
  }
  async archive() {
    await this.rpc.request("thread/archive", { threadId: this.sessionId });
  }
  async close() {
    await this.rpc.shutdown();
  }
}
