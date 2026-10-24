import { type AgentSession, type AgentSessionEvent, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Data, type RpcEvent, type Turn, string } from "../lib/protocol";
import { type PiState, savePiState } from "./pi-store";
import { piModel, piModelCatalog, piSettings, thinkingLevelSchema } from "./pi-models";
import { type Config } from "./config";
import { type CodexRpc } from "./rpc";
import { PiTaskContext } from "./pi-task-context";
import { PiMessages, publishAcceptedPiInput } from "./pi-projection";
import { openPiSession } from "./pi-session";
import { piInput } from "./pi-input";
import { PiQuestions } from "./pi-questions";
import { PiActivity } from "./pi-activity";

const LAST_TURN = -1;

/**
Embed Pi behind Pocket's canonical parent lifecycle while keeping native delegates separate.
*/
export class PiMain {
  private session?: AgentSession;
  private isClosed = false;
  private runtime?: ModelRuntime;
  private state?: PiState;
  private active?: Turn;
  private messages = new PiMessages();
  private selection = "openai/gpt-6.1-sol";
  private effort = "medium";
  private writes: Promise<void> = Promise.resolve();
  private tasks: PiTaskContext;
  private questions: PiQuestions;
  private activity: PiActivity;

  /** Bind this parent's existing identity, native read-only compatibility transport and event sink.
  @param config - Validated host-owned parent configuration.
  @param native - Native Codex transport used for migration and delegate inspection only.
  @param emit - Canonical event sink consumed by Bridge.
  @param readKey - Settings workstream's server-only key reader.
  @param onError - Private diagnostic sink.
  @param openSession - Session factory; offline flows replace provider streaming at this boundary.
  */
  constructor(
    private config: Config,
    private native: CodexRpc,
    private emit: (event: RpcEvent) => void,
    private readKey: () => Promise<string | null>,
    private onError: (error: unknown) => void,
    private openSession: typeof openPiSession = openPiSession
  ) {
    this.tasks = new PiTaskContext(config.threadId, readKey, onError);
    this.questions = new PiQuestions(config.threadId, () => this.active?.id, emit);
    this.activity = new PiActivity(config.threadId, emit);
  }

  /** Serialize durable UI projections without discarding a previous persistence failure.
  @returns Completion after this projection is durable.
  */
  private persist() {
    const state = structuredClone(this.state);
    const previous = this.writes;

    this.writes = (async () => {
      await previous;

      if (state) {
        await savePiState(this.config.threadId, state);
      }
    })();

    return this.writes;
  }

  /** Open Pi before exposing canonical resumed history to Bridge.
  @param params - Canonical resume settings.
  @returns Canonical session metadata with the original parent identity.
  */
  private async resume(params: Data) {
    const opened = await this.openSession(this.config, this.native, params, await this.readKey(), [
      this.questions.tool(),
    ]);

    this.state = opened.state;
    this.session = opened.session;
    this.runtime = opened.runtime;
    this.selection = opened.selection;
    this.effort = opened.session.thinkingLevel;
    await this.tasks.start(opened.manager, opened.session);
    opened.session.subscribe((event) => {
      if (event.type === "message_end" || event.type === "entry_appended") {
        this.tasks.sync(opened.manager);
      }

      this.event(event);
      this.activity.accept(event, this.active?.id);
    });
    await opened.session.bindExtensions({});
    await this.persist();

    return {
      thread: this.thread(),
      model: this.modelId(),
      reasoningEffort: this.effort,
      nativeDelegationProfile: opened.nativeDelegationProfile,
    };
  }

  /** Expose the selected catalog identity, including staged settings for subsequent turns.
  @returns Qualified provider/model ID.
  */
  private modelId() {
    return this.selection.includes("/") ? this.selection : `openai/${this.selection}`;
  }

  /** Expose existing canonical phone history with current Pi model metadata.
  @returns Pocket's stable parent identity and full phone projection.
  */
  private thread() {
    return {
      id: this.config.threadId,
      harness: "pi",
      executionBoundary: "Host process permissions; Pi does not enforce Codex sandbox or approval settings.",
      name: this.state?.name ?? "Pocket",
      turns: this.state?.turns ?? [],
      model: this.modelId(),
      reasoningEffort: this.effort,
    };
  }

  /** Normalize streamed messages and final source entries into existing Bridge notifications.
  @param event - Authoritative Pi lifecycle or message event.
  */
  private event(event: AgentSessionEvent) {
    if (event.type === "compaction_end" && event.result) {
      this.emit({ method: "thread/compacted", params: { threadId: this.config.threadId } });
    }

    if (event.type === "agent_settled" && event.aborted && this.active) {
      this.active.status = "interrupted";
    }

    if (
      !this.active ||
      (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end")
    ) {
      return;
    }

    this.messages.publish(event.message, this.active, this.state?.turns ?? [], this.config.threadId, this.emit);

    if (event.type === "message_end") {
      void this.persist().catch(this.onError);
    }
  }

  /** Complete one run only when prompt resolves after Pi's retries and queued continuations.
  @param error - Provider/run failure, absent on successful completion.
  */
  private async finish(error?: unknown) {
    const turn = this.active;

    if (!turn) {
      return;
    }

    const last = this.session?.messages.findLast((message) => message.role === "assistant");
    const isInterrupted = turn.status === "interrupted" || last?.stopReason === "aborted";
    const isFailed = !isInterrupted && (error !== undefined || last?.stopReason === "error");

    turn.status = isFailed ? "failed" : "completed";
    turn.error = isFailed
      ? { message: "Pi could not complete this turn. Inspect provider access and host logs." }
      : null;

    if (isInterrupted) {
      turn.status = "interrupted";
    }

    this.active = undefined;
    this.messages.promptId = undefined;
    await this.persist();
    this.emit({ method: "turn/completed", params: { threadId: this.config.threadId, turn } });
  }

  /** Accept a durable submission through Pi's preflight acknowledgment, never waiting for full inference.
  @param params - Canonical user input and receipt ID.
  @param isSteer - Whether to steer this exact active turn.
  @returns Accepted canonical turn metadata.
  */
  private async prompt(params: Data, isSteer: boolean) {
    const session = this.session;

    if (!session || !this.state || !this.runtime) {
      throw new Error("Pi is not initialized.");
    }

    this.tasks.interrupt();
    session.abortCompaction();
    await this.tasks.flush();
    const { text, images } = await piInput(params.input);

    if (isSteer) {
      if (!this.active || params.expectedTurnId !== this.active.id) {
        throw new Error("The requested Pi turn is no longer active; inspect before continuing.");
      }

      const turn = this.active;
      const receiptId = string(params.clientUserMessageId);

      this.messages.userIds.push(receiptId);
      await session.steer(text, images);
      // Acceptance owns visibility even while Pi is waiting on a tool or is later interrupted.
      publishAcceptedPiInput(turn, receiptId, text, this.config.threadId, this.emit);
      await this.persist();

      return { turnId: this.active.id };
    }

    if (this.active) {
      throw new Error("Pi already has active work.");
    }

    await session.setModel(piModel(this.runtime, this.selection));
    session.setThinkingLevel(thinkingLevelSchema.parse(this.effort));
    this.active = { id: crypto.randomUUID(), status: "inProgress", items: [] };
    this.state.turns.push(this.active);
    this.messages.promptId = string(params.clientUserMessageId);
    await this.persist();
    this.emit({ method: "turn/started", params: { threadId: this.config.threadId, turn: this.active } });
    const accepted = Promise.withResolvers<undefined>();
    const run = session.prompt(text, {
      images,
      expandPromptTemplates: false,
      preflightResult: () => {
        accepted.resolve(undefined);
      },
    });

    void (async () => {
      await (async () => {
        await run;
        await this.finish();
      })().catch(async (error: unknown) => {
        accepted.reject(error);
        this.onError(error);
        await this.finish(error);
      });
    })().catch(this.onError);
    await accepted.promise;

    return { turn: this.active ?? this.state.turns.at(LAST_TURN) };
  }

  /** Dispatch only parent lifecycle operations to Pi; delegate-native methods retain their original adapter.
  @param method - Canonical Pocket parent method.
  @param params - Validated protocol input.
  @returns Existing wire response shape for Bridge and session tools.
  */
  async request(method: string, params: Data): Promise<unknown> {
    switch (method) {
      case "thread/resume": {
        return this.resume(params);
      }

      case "thread/read": {
        return params.threadId === this.config.threadId
          ? { thread: this.thread() }
          : this.native.request(method, params);
      }

      case "thread/turns/list": {
        return params.threadId === this.config.threadId
          ? { data: this.state?.turns ?? [], nextCursor: null }
          : this.native.request(method, params);
      }

      case "turn/start": {
        return this.prompt(params, false);
      }

      case "turn/steer": {
        return this.prompt(params, true);
      }

      case "turn/interrupt": {
        if (params.threadId && params.threadId !== this.config.threadId) {
          return this.native.request(method, params);
        }

        if (!this.active || params.turnId !== this.active.id) {
          throw new Error("The requested Pi turn is no longer active; inspect before interrupting.");
        }

        this.active.status = "interrupted";
        await this.session?.abort();

        return {};
      }

      case "pocket/models": {
        return piModelCatalog(this.runtime, params);
      }

      case "thread/settings/update": {
        const settings = piSettings(this.runtime, params, { model: this.selection, effort: this.effort });

        this.selection = settings.model;
        this.effort = settings.effort;

        return {};
      }

      default: {
        return this.native.request(method, params);
      }
    }
  }

  /**
  Abort owned Pi work and release its MCP subprocesses and private persistence queue.
  */
  async close() {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.tasks.interrupt();
    this.session?.abortCompaction();
    await this.session?.abort();
    await this.tasks.stop();
    await this.session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    this.session?.dispose();
    await this.writes;
  }

  /** Resolve a structured phone question on this existing Pi session.
  @param id - Canonical pending request ID.
  @param answer - Validated phone response.
  */
  respond(id: string | number, answer: unknown) {
    this.questions.answer(String(id), answer);
  }
}
