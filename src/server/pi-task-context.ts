import { SerialQueue } from "../runtime/serial-queue";
import { valueAfterCleanup } from "../lib/results";
import { t as captureResult } from "try";
import { type AgentSession, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { type TaskContextState, groupTaskContext, ingestTaskEntry, readTaskState, saveTaskState } from "./task-context";
import { isSameTask } from "./task-decisions";
import { nativeText } from "../state/harness-transcript";
import { scheduleTaskIndex } from "./task-search";
import { saveTaskSource, taskDirectory } from "./task-archive";
import { internalContext } from "./internal-context";

const PASS_INTERVAL_MS = 600_000;
const LAST_ENTRY = -1;

/**
Maintain source ingestion separately from grouping; never rebuild active membership from closed tasks.
*/
export class PiTaskContext {
  private state?: TaskContextState;
  private timer?: NodeJS.Timeout;
  private serial: Promise<void> = Promise.resolve();
  private queue = new SerialQueue();
  private passController?: AbortController;

  /** Bind one parent and report private background failures without losing source context.
  @param owner - Durable parent identity.
  @param readKey - Central settings credential reader.
  @param onError - Host-owned diagnostic callback.
  */
  constructor(
    private owner: string,
    private readKey: () => Promise<string | null>,
    private onError: (error: unknown) => void
  ) {}

  /** Read only entries committed after the durable ingestion cursor.
  @param manager - Authoritative native session source.
  */
  private async ingestTail(manager: SessionManager) {
    if (!this.state) {
      throw new Error("Task context has not been initialized.");
    }

    const cursor = this.state.sourceCursor;

    if (cursor && !manager.getEntry(cursor)) {
      throw new Error("Task ingestion cursor is missing from the Pi source; inspect before replaying history.");
    }

    const arrived: SessionEntry[] = [];

    let tail = cursor ? manager.getChildren(cursor) : manager.getEntries();

    while (tail.length > 0) {
      arrived.push(...tail);
      tail = cursor ? manager.getChildren(tail.at(LAST_ENTRY)?.id ?? "") : [];
    }

    for (const entry of arrived) {
      await this.ingest(entry);
    }
  }

  /** Reconcile background work only while the native session is idle.
  @param session - Native model session.
  */
  private poll(session: AgentSession) {
    scheduleTaskIndex(this.owner);

    if (session.isIdle) {
      void this.passWhenIdle(session);
    }
  }

  /** Classify changed active context after checking current provider availability.
  @param session - Native model session.
  */
  private async classify(session: AgentSession) {
    if (
      !this.state ||
      !session.isIdle ||
      (this.state.revision === this.state.lastSeen && !this.state.compactionPending)
    ) {
      return;
    }

    const key = await this.readKey();

    if (!key) {
      return;
    }

    await this.process(session, key);
  }

  /** Serialize ingestion, grouping and persistence without poisoning later operations after errors.
  @param operation - Next private-state mutation.
  @returns Completion of this operation.
  */
  private enqueue(operation: () => Promise<void>) {
    this.serial = this.queue.run(operation);

    return this.serial;
  }

  /** Group a changed active set while allowing incoming user work to preempt the provider call.
  @param session - Idle native Pi session.
  @param key - Current central credential.
  */
  private async process(session: AgentSession, key: string) {
    const controller = new AbortController();

    this.passController = controller;

    const grouped = await captureResult(this.groupAndCompact.bind(this), session, key, controller.signal);

    this.passController = undefined;

    if (grouped.ok) {
      return;
    }

    const error = grouped.error;

    // Retain the checkpoint; provider failures must not reject later user submissions.
    if (!(error instanceof Error && error.name === "AbortError")) {
      this.onError(error);
    }
  }

  /** Apply checkpointed grouping, then use Pi's native compactor with exact archive references.
  @param session - Idle native session.
  @param key - Central provider credential.
  @param signal - User-input cancellation for background grouping.
  */
  private async groupAndCompact(session: AgentSession, key: string, signal: AbortSignal) {
    if (!this.state) {
      return;
    }

    const grouped = await captureResult(
      groupTaskContext,
      this.owner,
      this.state,
      isSameTask.bind(undefined, key, signal)
    );

    if (!grouped.ok) {
      const restored = await captureResult(readTaskState, this.owner);

      if (restored.ok) {
        this.state = restored.value;
      }

      valueAfterCleanup(grouped, restored);

      return;
    }

    this.state = grouped.value.state;

    if (!this.state.compactionPending || session.isStreaming || signal.aborted) {
      return;
    }

    await session.compact(
      internalContext(
        "task_compaction",
        "Preserve all open tasks, pending questions, constraints, decisions and delegate identities. " +
          "Preserve original roles, internal visibility and evidence of actual user delivery. " +
          `Exact task context is archived in ${taskDirectory(this.owner)}. ` +
          "Include archive references for completed tasks and silently read originals when prior work is referenced."
      )
    );
    this.state = { ...this.state, compactionPending: false };
    await saveTaskState(this.owner, this.state);
  }

  /** Persist one committed native entry before advancing its durable ingestion cursor.
  @param entry - Newly appended native entry, never a historical closed-group member.
  */
  private async ingest(entry: SessionEntry) {
    if (!this.state) {
      throw new Error("Task context has not been initialized.");
    }

    if (entry.type === "message") {
      const source = {
        id: entry.id,
        sequence: this.state.revision,
        role: entry.message.role,
        text: nativeText("content" in entry.message ? entry.message.content : ""),
        original: entry,
      };

      await saveTaskSource(this.owner, source);
      this.state = ingestTaskEntry(this.state, source);
    }

    this.state = { ...this.state, sourceCursor: entry.id };
    await saveTaskState(this.owner, this.state);
  }

  /** Report an idle timer pass without rejecting the event loop callback.
  @param session - Session whose idle state controls grouping.
  */
  private async passWhenIdle(session: AgentSession) {
    const passed = await captureResult(this.pass.bind(this), session);

    if (!passed.ok) {
      this.onError(passed.error);
    }
  }

  /** Queue a committed source-tail read after the SDK's synchronous message persistence.
  @param manager - Authoritative append-only Pi session source; events can precede its append.
  */
  async sync(manager: SessionManager) {
    // enqueue awaits the preceding write before reading. message_end's listener returns
    // to Pi so it can append the native entry before this queued operation observes it.
    const synced = await captureResult(this.enqueue.bind(this), this.ingestTail.bind(this, manager));

    if (!synced.ok) {
      this.onError(synced.error);
    }
  }

  /** Restore direct state and ingest only the unprocessed source tail before accepting work.
  @param manager - Authoritative append-only Pi session source.
  @param session - Session whose idle state gates provider calls and compaction.
  */
  async start(manager: SessionManager, session: AgentSession) {
    this.state = await readTaskState(this.owner);
    scheduleTaskIndex(this.owner);
    void this.sync(manager);
    await this.serial;
    this.timer = setInterval(this.poll.bind(this, session), PASS_INTERVAL_MS);
    this.timer.unref();
  }

  /** Process a changed idle chat with durable task checkpoints, retaining active context on classification failure.
  @param session - Pi session that owns the compaction operation.
  @returns Completion of one serialized changed-chat pass.
  */
  pass(session: AgentSession) {
    return this.enqueue(this.classify.bind(this, session));
  }

  /**
  Give new user input priority over background classification.
  */
  interrupt() {
    this.passController?.abort();
  }

  /** Wait for classification and source writes before accepting a new prompt.
  @returns Completion of all currently queued archive operations.
  */
  async flush() {
    const completed = await captureResult(this.serial);

    if (completed.ok) {
      return;
    }

    const error = completed.error;

    if (!(error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
  }

  /** Stop background classification and flush queued source writes before shutdown.
  @returns Completion after outstanding source persistence settles.
  */
  async stop() {
    clearInterval(this.timer);
    this.interrupt();
    await this.flush();
  }
}
