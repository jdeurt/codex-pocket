import { t as captureResult } from "try";
import { type AgentSession, type AgentSessionEvent, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Data, type RpcEvent, string } from "../lib/protocol";
import { PiHistory } from "../runtime/pi-history";
import { acceptedPiInput, completedPiTurn } from "../state/pi-messages";
import { findById } from "../lib/identity";
import { requireResults } from "../lib/results";
import { piModel, piModelCatalog, piSettings, thinkingLevelSchema } from "./pi-models";
import { type Config } from "./config";
import { type CodexRpc } from "./rpc";
import { reconcileTaskDeliveries } from "../tasks/delivery-evidence";
import { preservePiOrigins } from "../tasks/adapters/pi";
import { PiTaskContext } from "../tasks/runtime";
import { PiMessages } from "./pi-projection";
import { openPiSession } from "./pi-session";
import { piInput } from "./pi-input";
import { PiQuestions } from "./pi-questions";
import { PiActivity } from "./pi-activity";
import { PiChat } from "./pi-chat";
import { PiCosts } from "./cost-tracking";

/**
Embed Pi behind Pocket's canonical parent lifecycle while keeping native delegates separate.
*/
export class PiMain {
  private session?: AgentSession;
  private isClosed = false;
  private runtime?: ModelRuntime;
  private history: PiHistory;
  private messages = new PiMessages();
  private selection = "openai/gpt-6.1-sol";
  private effort = "medium";
  private tasks: PiTaskContext;
  private questions: PiQuestions;
  private activity: PiActivity;
  private costs?: PiCosts;

  /** Bind this parent's existing identity, native read-only compatibility transport and event sink.
  @param config - Validated host-owned parent configuration.
  @param native - Native Codex transport used for migration and delegate inspection only.
  @param emit - Canonical event sink consumed by Bridge.
  @param readKey - Settings workstream's server-only key reader.
  @param onError - Private diagnostic sink.
  @param openSession - Session factory; offline flows replace provider streaming at this boundary.
  @param readTaskKey - Optional independent classifier credential reader for provider-isolated workflows.
  */
  constructor(
    private config: Config,
    private native: CodexRpc,
    private emit: (event: RpcEvent) => void,
    private readKey: () => Promise<string | null>,
    private onError: (error: unknown) => void,
    private openSession: typeof openPiSession = openPiSession,
    readTaskKey: () => Promise<string | null> = readKey
  ) {
    this.history = new PiHistory(config.threadId, emit, onError);
    this.tasks = new PiTaskContext(config.threadId, readTaskKey, onError);
    this.questions = new PiQuestions(config.threadId, this.history.activeIdentity, emit);
    this.activity = new PiActivity(config.threadId, emit);
  }

  /** Reconcile background model completion with the original preflight acknowledgement.
  @param run - Existing native prompt operation.
  @param accepted - Original submission acknowledgement.
  */
  private async settleTurn(run: Promise<void>, accepted: PromiseWithResolvers<undefined>) {
    const prompted = await captureResult(run);
    const finished = prompted.ok ? await captureResult(this.finish.bind(this)) : prompted;

    if (finished.ok) {
      return;
    }

    accepted.reject(finished.error);
    this.onError(finished.error);
    const recovered = await captureResult(this.finish.bind(this), finished.error);

    if (!recovered.ok) {
      this.onError(recovered.error);
    }
  }

  /** Forward native events and source writes without waiting for storage.
  @param manager - Native append-only session source.
  @param event - Native lifecycle event.
  */
  private observed(manager: Awaited<ReturnType<typeof openPiSession>>["manager"], event: AgentSessionEvent) {
    void this.history.event(this.messages, event);

    if (event.type === "message_end") {
      preservePiOrigins(manager, this.messages.receiptIdentity(event.message), event.message, this.history.active?.id);
    }

    if (event.type === "message_end" || event.type === "entry_appended") {
      this.costs?.sync(manager.getEntries());
      void this.tasks.sync(manager);
    } else if (["turn_end", "agent_end", "auto_compaction_end"].includes(event.type)) {
      this.costs?.sync(manager.getEntries());
    }

    this.activity.accept(event, this.history.active?.id);
  }

  /** Open Pi before exposing canonical resumed history to Bridge.
  @param params - Canonical resume settings.
  @returns Canonical session metadata with the original parent identity.
  */
  private async resume(params: Data) {
    const opened = await this.openSession(this.config, this.native, params, await this.readKey(), [
      this.questions.tool(),
      new PiChat(this.config.threadId, this.history).tool(),
    ]);

    this.history.restore(opened.state);
    this.session = opened.session;
    this.runtime = opened.runtime;
    this.costs = new PiCosts(this.config.threadId);
    this.costs.sync(opened.manager.getEntries());
    this.selection = opened.selection;
    this.effort = opened.session.thinkingLevel;
    await this.tasks.start(opened.manager, opened.session);
    await reconcileTaskDeliveries(this.config.threadId, opened.state.turns);
    this.tasks.reviewSoon();
    opened.session.subscribe(this.observed.bind(this, opened.manager));
    await opened.session.bindExtensions({});
    await this.history.persist();

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
      name: this.history.saved?.name ?? "Pocket",
      turns: this.history.saved?.turns ?? [],
      model: this.modelId(),
      reasoningEffort: this.effort,
    };
  }

  /** Complete one run only when prompt resolves after Pi's retries and queued continuations.
  @param error - Provider/run failure, absent on successful completion.
  */
  private async finish(error?: unknown) {
    const turn = this.history.active;

    if (!turn) {
      return;
    }

    const completed = completedPiTurn(turn, this.session?.messages ?? [], error);

    this.history.update(completed, undefined);
    this.messages.promptId = undefined;
    await this.history.persist();
    await this.tasks.flushSources();
    await reconcileTaskDeliveries(this.config.threadId, [completed]);
    this.emit({ method: "turn/completed", params: { threadId: this.config.threadId, turn: completed } });
    this.tasks.reviewSoon();
  }

  /** Accept a durable submission through Pi's preflight acknowledgment, never waiting for full inference.
  @param params - Canonical user input and receipt ID.
  @param isSteer - Whether to steer this exact active turn.
  @returns Accepted canonical turn metadata.
  */
  private async prompt(params: Data, isSteer: boolean) {
    const session = this.session;

    if (!session || !this.history.saved || !this.runtime) {
      throw new Error("Pi is not initialized.");
    }

    this.tasks.interrupt();
    session.abortCompaction();
    await this.tasks.flushSources();
    const { text, images } = await piInput(params.input);

    if (isSteer) {
      if (!this.history.active || params.expectedTurnId !== this.history.active.id) {
        throw new Error("The requested Pi turn is no longer active; inspect before continuing.");
      }

      const turn = this.history.active;
      const receiptId = string(params.clientUserMessageId);

      await this.messages.steer(session, receiptId, text, images);
      // Acceptance owns visibility even while Pi is waiting on a tool or is later interrupted.
      const current = findById(this.history.saved.turns, turn.id) ?? turn;

      this.history.publish(acceptedPiInput(current, receiptId, text, this.config.threadId));
      await this.history.persist();

      return { turnId: turn.id };
    }

    if (this.history.active) {
      throw new Error("Pi already has active work.");
    }

    await session.setModel(piModel(this.runtime, this.selection));
    session.setThinkingLevel(thinkingLevelSchema.parse(this.effort));
    const turn = { id: crypto.randomUUID(), status: "inProgress", items: [] };

    this.history.update(turn, turn.id);
    this.messages.promptId = string(params.clientUserMessageId);
    await this.history.persist();
    this.emit({ method: "turn/started", params: { threadId: this.config.threadId, turn: this.history.active } });
    const accepted = Promise.withResolvers<undefined>();
    const run = session.prompt(text, {
      images,
      expandPromptTemplates: false,
      preflightResult: accepted.resolve.bind(undefined, undefined),
    });

    void this.settleTurn(run, accepted);
    await accepted.promise;

    return { turn: findById(this.history.saved.turns, turn.id) ?? turn };
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
          ? { data: this.history.saved?.turns ?? [], nextCursor: null }
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

        if (!this.history.active || params.turnId !== this.history.active.id) {
          throw new Error("The requested Pi turn is no longer active; inspect before interrupting.");
        }

        this.history.update({ ...this.history.active, status: "interrupted" }, this.history.active.id);
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
    const aborted = await captureResult(this.session?.abort() ?? Promise.resolve());
    const stopped = await captureResult(this.tasks.stop.bind(this.tasks));
    const notified = await captureResult(
      this.session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }) ?? Promise.resolve()
    );
    const disposed = this.session ? captureResult(this.session.dispose.bind(this.session)) : stopped;
    const saved = await captureResult(this.history.flush());

    requireResults([aborted, stopped, notified, disposed, saved], "Pi session shutdown failed.");
  }

  /** Resolve a structured phone question on this existing Pi session.
  @param id - Canonical pending request ID.
  @param answer - Validated phone response.
  */
  respond(id: string | number, answer: unknown) {
    this.questions.answer(String(id), answer);
  }
}
