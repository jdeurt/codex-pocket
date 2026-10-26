import path from "node:path";
import { readTaskSources } from "./sources";
import { nativeSourceSequence } from "./adapters/pi";
import { t } from "try";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { SerialQueue } from "../runtime/serial-queue";
import { nativeText } from "../state/harness-transcript";
import { readTaskLedger } from "./management";
import { migrateTaskLedger } from "./migration";
import { ingestNativeTaskEvent } from "./native-ingestion";
import { classifyTaskLedger } from "./classification-runtime";
import { saveTaskSource, taskDirectory } from "./archive";
import { scheduleTaskIndex } from "./retrieval/runtime";
import { regenerateTaskProjections } from "./projections";
import { reviewTaskLifecycle } from "./lifecycle-runtime";

const NOT_FOUND = -1;
const PASS_INTERVAL_MS = 600_000;
const REVIEW_DELAY_MS = 250;

/** Match a recorded native cursor without interpreting source text.
@param id - Native identity.
@param entry - Source record.
@returns Identity equality.
*/
function hasNativeId(id: string, entry: { id: string }) {
  return entry.id === id;
}

/**
Effectful owner of native ingestion and preemptible background classification. The ledger owns task state.
*/
export class PiTaskContext {
  private timer?: NodeJS.Timeout;
  private reviewTimer?: NodeJS.Timeout;
  private session?: AgentSession;
  private reviewTask?: Promise<void>;
  private needsReview = false;
  private isStopped = false;
  private generation = 0;
  private serial: Promise<void> = Promise.resolve();
  private readonly queue = new SerialQueue();
  private passController?: AbortController;

  /** Bind one parent and its effectful credential and diagnostic interfaces.
  @param owner - Application-owned parent identity.
  @param readKey - Central credential reader.
  @param onError - Private diagnostic sink.
  */
  constructor(
    private readonly owner: string,
    private readonly readKey: () => Promise<string | null>,
    private readonly onError: (error: unknown) => void
  ) {}

  /** Ingest committed native originals after the durable cursor without replaying input.
  @param manager - Authoritative append-only source.
  */
  private async ingestTail(manager: SessionManager) {
    const entries = manager.getEntries();
    const sources = await readTaskSources(this.owner);

    let state = readTaskLedger(this.owner);

    const cursor = state.cursor;

    let index = 0;

    if (cursor) {
      const position = entries.findIndex(hasNativeId.bind(undefined, cursor));

      if (position === NOT_FOUND) {
        throw new Error("Task source cursor is missing from the native history; inspect before replaying anything.");
      }

      index = position + 1;
    }

    for (const entry of entries.slice(index)) {
      let sourceFile = "";

      const sequence = nativeSourceSequence(entry, sources, state.nextSequence);

      if (entry.type === "message") {
        const source = {
          id: entry.id,
          sequence,
          role: entry.message.role,
          text: nativeText("content" in entry.message ? entry.message.content : ""),
          original: entry,
        };

        await saveTaskSource(this.owner, source);
        sourceFile = path.join(taskDirectory(this.owner), "source", `${String(sequence)}.json`);
      }

      state = ingestNativeTaskEvent(this.owner, entries, entry, sourceFile, sequence);
    }

    scheduleTaskIndex(this.owner);
  }

  /** Interpret pending intent and assess lifecycle independently of the working main agent.
  @param key - Central provider credential.
  @param session - Native execution-state observation.
  @param signal - New-input preemption boundary.
  */
  private async reconcile(key: string, session: AgentSession, signal: AbortSignal) {
    await classifyTaskLedger(this.owner, key, signal);
    signal.throwIfAborted();
    await reviewTaskLifecycle(this.owner, key, !session.isIdle, signal);
  }

  /** Review a stable source snapshot without preventing ingestion while network work is pending.
  @param session - Native execution-state observation; turn completion alone never resolves work.
  @param generation - Runtime preemption generation captured before asynchronous source/key reads.
  */
  private async classify(session: AgentSession, generation: number) {
    await this.serial;
    const key = await this.readKey();

    if (!key || generation !== this.generation) {
      return;
    }

    const controller = new AbortController();

    this.passController = controller;
    const classified = await t(this.reconcile.bind(this), key, session, controller.signal);

    this.passController = undefined;

    if (!classified.ok && !controller.signal.aborted) {
      this.onError(classified.error);
    }

    await regenerateTaskProjections(this.owner);
    scheduleTaskIndex(this.owner);
  }

  /** Release the background-review lifetime and schedule another pass when source evidence changed during it.
  @param session - Owning native session.
  @param generation - Exact preemption generation of this review.
  */
  private async runReview(session: AgentSession, generation: number) {
    const result = await t(this.classify.bind(this), session, generation);

    this.reviewTask = undefined;

    if (this.needsReview) {
      this.reviewSoon();
    }

    if (!result.ok) {
      throw result.error;
    }
  }

  /** Report timer failures without leaving an unobserved rejection.
  @param session - Parent session.
  */
  private async poll(session: AgentSession) {
    const result = await t(this.pass.bind(this), session);

    if (!result.ok) {
      this.onError(result.error);
    }
  }

  /** Schedule the owned asynchronous timer pass without returning a promise to Node's timer.
  @param session - Parent session.
  */
  private tick(session: AgentSession) {
    void this.poll(session);
  }

  /** Queue source-tail observation after Pi's synchronous native append.
  @param manager - Native source owner.
  */
  async sync(manager: SessionManager) {
    this.serial = this.queue.run(this.ingestTail.bind(this, manager));
    const result = await t(this.serial);

    if (!result.ok) {
      this.onError(result.error);
    }

    this.reviewSoon();
  }

  /** Restore ledger state and conservative legacy membership before accepting new native work.
  @param manager - Native persistence owner.
  @param session - Native session whose idle state gates classification.
  */
  async start(manager: SessionManager, session: AgentSession) {
    this.session = session;
    await migrateTaskLedger(this.owner);
    await this.sync(manager);
    await this.flush();
    await regenerateTaskProjections(this.owner);
    this.timer = setInterval(this.tick.bind(this, session), PASS_INTERVAL_MS);
    this.timer.unref();
  }

  /**
  Coalesce source and turn-state changes into a prompt-independent lifecycle review.
  */
  reviewSoon() {
    if (!this.session || this.isStopped) {
      return;
    }

    if (this.reviewTask) {
      this.needsReview = true;

      return;
    }

    this.needsReview = false;
    clearTimeout(this.reviewTimer);
    this.reviewTimer = setTimeout(this.tick.bind(this, this.session), REVIEW_DELAY_MS);
    this.reviewTimer.unref();
  }

  /** Run one background review independently of the source-ingestion queue and context compaction.
  @param session - Native session used only for runtime execution facts.
  @returns Completion of the background pass.
  */
  pass(session: AgentSession) {
    if (!this.reviewTask) {
      this.needsReview = false;
      this.reviewTask = this.runReview(session, this.generation);
    }

    return this.reviewTask;
  }

  /**
  Give newly accepted work priority over provider interpretation.
  */
  interrupt() {
    this.generation++;
    clearTimeout(this.reviewTimer);
    this.needsReview = false;
    this.passController?.abort();
  }

  /** Wait for current source persistence and background work.
  @returns Completion, propagating source and persistence failures.
  */
  async flush() {
    await this.serial;
    await this.reviewTask;
  }

  /** Join native source persistence without waiting for independent network classification.
  @returns Completion of the latest source observation.
  */
  flushSources() {
    return this.serial;
  }

  /** Stop owned background resources and finish pending persistence.
  @returns Completion of shutdown.
  */
  async stop() {
    this.isStopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reviewTimer);
    this.interrupt();
    await this.flush();
  }
}
