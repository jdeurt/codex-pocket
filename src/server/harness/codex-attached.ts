import { type AdapterOptions, type HarnessAdapter, type HarnessResult } from "./types";
import { RpcDisconnectEvent, RpcNotificationEvent } from "../rpc-events";
import { type RpcEvent, type Turn, string } from "../../lib/protocol";
import { CodexRpc } from "../rpc";
import { harnessMessages } from "./transcript";
import { loadHistory } from "../history";
import { requireLoadedSession } from "../session-adoption";
import { steerCodex } from "./codex-steering";

/**
Observe and address the actual owning app-server while retaining its policy and process ownership.
*/
export class AttachedCodexAdapter implements HarnessAdapter {
  private rpc = new CodexRpc();
  private active?: string;
  private pending?: { resolve: (result: HarnessResult) => void; reject: (error: Error) => void };
  private completed = new Map<string, HarnessResult>();
  private output = new Map<string, string>();

  /**
  Subscribe before opening the socket so completion cannot race native subscription.
  @param options - Adopted child identity and durable worker callbacks.
  */
  constructor(private options: AdapterOptions) {
    this.rpc.addEventListener("event", (event) => {
      if (event instanceof RpcNotificationEvent) {
        this.event(event.notification);
      }
    });
    this.rpc.addEventListener("disconnect", (event) => {
      if (event instanceof RpcDisconnectEvent) {
        this.pending?.reject(event.error);
      }
    });
  }

  /**
  Build a completion report from the native turn, preserving its actual status.
  @param turn - Native completed or interrupted turn.
  @returns Original assistant output and terminal outcome.
  */
  private result(turn: Turn): HarnessResult {
    const text = turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => string(item.text))
      .join("\n\n");

    return {
      status: turn.status === "completed" || turn.status === "interrupted" ? turn.status : "failed",
      text: text || this.output.values().toArray().join("\n\n") || (turn.error?.message ?? ""),
    };
  }

  /**
  Route only this session's notifications; the owning client retains approval handling.
  @param event - Validated native notification or server request.
  */
  private event(event: RpcEvent) {
    if (event.params.threadId !== this.options.child.sessionId || event.id !== undefined) {
      return;
    }

    if (event.method === "turn/started") {
      this.active = event.params.turn?.id;
    }

    if (event.method === "item/completed" && event.params.item?.type === "agentMessage") {
      this.output.set(event.params.item.id, string(event.params.item.text));
      this.options.callbacks.output(string(event.params.item.text));
    }

    if (event.method !== "turn/completed" || !event.params.turn) {
      return;
    }

    this.completeTurn(event.params.turn);
  }

  /**
  Retain terminal results even when native completion precedes watch setup.
  @param turn - Native terminal turn.
  */
  private completeTurn(turn: Turn) {
    const result = this.result(turn);

    this.completed.set(turn.id, result);

    if (turn.id !== this.active) {
      return;
    }

    this.active = undefined;
    this.pending?.resolve(result);
  }

  /**
  Subscribe without changing the owner's model, permissions or instructions.
  @param sessionId - Session already confirmed loaded by this server.
  @returns Original native session identity.
  */
  private async subscribe(sessionId: string) {
    const { thread, model, reasoningEffort } = await this.rpc.request("thread/resume", { threadId: sessionId });

    if (thread.id !== sessionId) {
      throw new Error("The owning server returned a different session identity.");
    }

    this.active = thread.turns.findLast((turn) => turn.status === "inProgress" && !this.completed.has(turn.id))?.id;
    this.options.callbacks.metadata({ model, effort: reasoningEffort, sessionStarted: true });

    return thread.id;
  }

  /**
  Install completion handling before the native send can produce an immediate response.
  @param id - Stable native message identity.
  @param text - Exact assignment text.
  @returns Actual terminal native result.
  */
  private async start(id: string, text: string) {
    const pending = Promise.withResolvers<HarnessResult>();

    this.pending = pending;
    void this.send(id, text).catch((error: unknown) => {
      pending.reject(error);
    });

    try {
      return await pending.promise;
    } finally {
      this.pending = undefined;
    }
  }

  /**
  Submit a follow-up through the owning server with its existing policy and configuration.
  @param id - Stable native message identity.
  @param text - Exact assignment text.
  */
  private async send(id: string, text: string) {
    const { turn } = await this.rpc.request("turn/start", {
      threadId: this.options.child.sessionId,
      clientUserMessageId: id,
      input: [{ type: "text", text, text_elements: [] }],
    });
    const completed = this.completed.get(turn.id);

    if (completed) {
      this.pending?.resolve(completed);
    } else {
      this.active = turn.id;
    }
  }

  /**
  Subscribe to a thread already loaded by this exact owner, without configuration overrides.
  @returns The unchanged native thread identity.
  */
  async open() {
    const { child } = this.options;

    if (!child.attachment || !child.sessionId) {
      throw new Error("An existing session and owning socket are required.");
    }

    await this.rpc.connectSocket(child.attachment.socketPath);
    await requireLoadedSession(this.rpc, child.sessionId);

    return this.subscribe(child.sessionId);
  }

  /**
  Observe one already-started turn, including completion before the worker acquired its slot.
  @param turnId - Exact turn captured during adoption.
  @returns Existing turn's result without a new native input.
  */
  async watch(turnId: string) {
    const { thread } = await this.rpc.request("thread/read", {
      threadId: this.options.child.sessionId,
      includeTurns: true,
    });
    const turns = await loadHistory(this.rpc, thread);
    const turn = turns.find((entry) => entry.id === turnId);
    const completed = this.completed.get(turnId);

    if (completed) {
      return completed;
    }

    if (!turn) {
      throw new Error("The attached turn is no longer available. No replacement turn was started.");
    }

    if (turn.status !== "inProgress") {
      return this.result(turn);
    }

    this.active = turnId;

    return new Promise<HarnessResult>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /**
  Start a later assignment only when the owning session has no current turn.
  @param id - Durable native message identity.
  @param text - Follow-up assignment.
  @returns Actual terminal native result.
  */
  async run(id: string, text: string) {
    const { thread } = await this.rpc.request("thread/read", {
      threadId: this.options.child.sessionId,
      includeTurns: true,
    });

    if (thread.turns.some((turn) => turn.status === "inProgress")) {
      throw new Error("The owning window started another turn. Nothing was sent; inspect it before continuing.");
    }

    this.output.clear();

    return this.start(id, text);
  }

  /**
  Read the full native transcript without copying or replacing it.
  @returns Canonical saved history from the actual owning server.
  */
  async history() {
    const { thread } = await this.rpc.request("thread/read", {
      threadId: this.options.child.sessionId,
      includeTurns: true,
    });

    return harnessMessages(await loadHistory(this.rpc, thread));
  }

  /**
  Steer only the attached active turn using native compare-and-set semantics.
  @param id - Durable correction identity.
  @param text - Current-task correction.
  @returns Native acceptance or explicit uncertainty.
  */
  async steer(id: string, text: string) {
    return steerCodex(this.rpc, this.options.child.sessionId ?? undefined, this.active, id, text);
  }

  /**
  Detaching never interrupts a turn owned by another window.
  @returns Immediate completion without a native interruption.
  */
  interrupt() {
    return Promise.resolve();
  }

  /**
  An externally owned session cannot be archived through delegate cleanup.
  @returns Explicit rejection with instructions for the owning window.
  */
  archive() {
    return Promise.reject(new Error("Archive this session through its owning Codex window."));
  }

  /**
  Release only Pocket's connection, leaving the native owner and its turn running.
  */
  async close() {
    await this.rpc.shutdown();
  }
}
