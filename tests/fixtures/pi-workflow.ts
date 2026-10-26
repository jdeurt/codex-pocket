import { fauxProvider } from "@earendil-works/pi-ai";
import { type TestContext } from "node:test";
import { type RpcEvent, type Turn, object, threadSchema } from "../../src/lib/protocol";
import { CodexRpc } from "../../src/server/rpc";
import { PiMain } from "../../src/server/pi-main";
import { openPiSession } from "../../src/server/pi-session";
import { nativeWorkspace, eventually } from "./workflow";
import { settleTaskIndex } from "../../src/tasks/retrieval/runtime";
import assert from "node:assert/strict";

type NativeFixture = Awaited<ReturnType<typeof nativeWorkspace>>;
type KeyReader = () => Promise<string | null>;

/** Provide the synthetic main-model credential used only by the registered replay provider.
@returns A fixture credential, never a live provider key.
*/
function mainCredential() {
  return Promise.resolve("synthetic-pi-key");
}

/** Leave external task inference disabled unless a workflow explicitly supplies its replay boundary.
@returns No classifier credential.
*/
function noTaskCredential() {
  return Promise.resolve(null);
}

/** Close one actual native main session through its production lifecycle.
@param session - Owned replay session.
@returns Complete shutdown.
*/
function closeSession(session: PiMain) {
  return session.close();
}

/** Match a canonical completion event.
@param event - Observed production event.
@returns Whether the event completes a main turn.
*/
function isCompleted(event: RpcEvent) {
  return event.method === "turn/completed";
}

/** Observe a completion after one specific accepted submission.
@param events - Owned canonical event stream.
@param start - Original event offset.
@returns Whether the submitted turn finished.
*/
function hasCompleted(events: RpcEvent[], start: number) {
  return events.slice(start).some(isCompleted.bind(undefined));
}

/**
Effectful owner of replay providers, native transports and real Pi sessions for one isolated workflow.
*/
class PiWorkflowRuntime {
  private readonly errors: unknown[] = [];
  private readonly sessions: PiMain[] = [];
  private readonly configureResponses: ReturnType<typeof fauxProvider>["setResponses"];
  private expectedProviderCalls = 0;
  readonly native = new CodexRpc();
  readonly provider = fauxProvider({ provider: "pocket-workflow", models: [{ id: "notes" }, { id: "review" }] });
  readonly events: RpcEvent[] = [];

  /** Own native cleanup and keep main-model replay independent from task-classifier replay.
  @param fixture - Isolated native state.
  @param readTaskKey - Explicit optional external classifier boundary.
  */
  constructor(
    private readonly fixture: NativeFixture,
    private readonly readTaskKey: KeyReader
  ) {
    this.configureResponses = this.provider.setResponses;
    this.provider.setResponses = this.setResponses.bind(this);
    fixture.cleanup(this.close.bind(this));
  }

  /** Count every expected external main-model response.
  @param responses - Exact documented faux-provider responses.
  */
  private setResponses(responses: Parameters<typeof this.provider.setResponses>[0]) {
    assert.equal(this.provider.getPendingResponseCount(), 0, "Previous replay inputs must be consumed first");
    this.expectedProviderCalls += responses.length;
    this.configureResponses(responses);
  }

  /** Observe immutable canonical events.
  @param event - Actual main event.
  */
  private recordEvent(event: RpcEvent) {
    this.events.push(structuredClone(event));
  }

  /** Retain failures so background errors cannot silently pass a workflow.
  @param error - Actual runtime failure.
  */
  private recordError(error: unknown) {
    this.errors.push(error);
  }

  /** Register only the documented provider replay boundary in the actual SDK session.
  @param args - Unchanged production session inputs.
  @returns Production session with a deterministic main-model selection.
  */
  private async open(...args: Parameters<typeof openPiSession>) {
    const opened = await openPiSession(...args);

    opened.runtime.registerNativeProvider(this.provider.provider);

    return { ...opened, selection: "pocket-workflow/notes" };
  }

  /** Create an actual production parent session with isolated inference boundaries.
  @returns Main session owned by this workflow.
  */
  create() {
    const main = new PiMain(
      this.fixture.config,
      this.native,
      this.recordEvent.bind(this),
      mainCredential,
      this.recordError.bind(this),
      this.open.bind(this),
      this.readTaskKey
    );

    this.sessions.push(main);

    return main;
  }

  /** Read canonical history from the selected actual main session.
  @param fallback - Initially opened main session.
  @param session - Optional restored session.
  @returns Parent-visible turns.
  */
  async history(fallback: PiMain, session = fallback) {
    const result = await session.request("thread/read", { threadId: this.fixture.parent.id });

    return threadSchema.parse(object(result).thread).turns;
  }

  /** Submit input through production acceptance and await its canonical completion.
  @param fallback - Initially opened main session.
  @param id - Exact accepted receipt identity.
  @param text - Original current request.
  @param session - Optional restored session.
  @returns Completed turn.
  */
  async send(fallback: PiMain, id: string, text: string, session = fallback) {
    const start = this.events.length;

    await session.request("turn/start", { clientUserMessageId: id, input: [{ type: "text", text }] });
    await eventually(hasCompleted.bind(undefined, this.events, start), `Pi must finish ${id}`);
    const completed = this.events.slice(start).find(isCompleted.bind(undefined));
    const turn = completed?.params.turn;

    assert.ok(turn);

    return turn;
  }

  /**
  Release owned sessions and assert every replay response and native operation was accounted for.
  */
  async close() {
    await Promise.all(Array.from(this.sessions, closeSession));
    await this.native.shutdown();
    await settleTaskIndex(this.fixture.parent.id);
    assert.deepEqual(this.errors, [], "Background Pi failures must fail the workflow");
    assert.equal(this.provider.getPendingResponseCount(), 0, "All required provider inputs must be consumed");
    assert.equal(this.provider.state.callCount, this.expectedProviderCalls, "Unexpected inference calls fail replay");
  }
}

/** Supply the exact native configuration response expected on each real session opening.
@returns Unmodified compatibility configuration.
*/
function nativeConfig() {
  return {
    method: "config/read",
    result: { config: { sandbox_mode: "read-only", approval_policy: "never" }, origins: {} },
  };
}

/** Open real Pi parsing, tools and storage with separately controlled main and task-classifier providers.
@param t - Workflow context owning transports and durable state.
@param resumes - Exact number of expected session openings.
@param turns - Saved Codex history for the real Pi migration path.
@param readTaskKey - Explicit classifier replay credential reader; disabled for unrelated workflows.
@returns Production session and deterministic provider responses.
*/
export async function piWorkflow(
  t: TestContext,
  resumes = 1,
  turns: Turn[] = [],
  readTaskKey: KeyReader = noTaskCredential
) {
  const scripts = Array.from({ length: resumes }, nativeConfig);
  const fixture = await nativeWorkspace(t, { scripts }, turns);
  const runtime = new PiWorkflowRuntime(fixture, readTaskKey);

  await runtime.native.connect(fixture.config, "bare");
  const main = runtime.create();

  await main.request("thread/resume", {});

  return {
    ...fixture,
    main,
    create: runtime.create.bind(runtime),
    provider: runtime.provider,
    events: runtime.events,
    history: runtime.history.bind(runtime, main),
    send: runtime.send.bind(runtime, main),
  };
}
