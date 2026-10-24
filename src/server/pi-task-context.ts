import { t as captureResult } from "try";
import { type AgentSession, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { type TaskContextState, groupTaskContext, ingestTaskEntry, readTaskState, saveTaskState } from "./task-context";
import { isSameTask } from "./task-decisions";
import { nativeText } from "./harness/transcript";
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

  /** Serialize ingestion, grouping and persistence without poisoning later operations after errors.
  @param operation - Next private-state mutation.
  @returns Completion of this operation.
  */
  private enqueue(operation: () => Promise<void>) {
    this.serial = this.runQueued(this.serial, operation);

    return this.serial;
  }

  /** Wait for the preceding archive write before executing the next mutation.
  @param previous - Completion reserved by the preceding owner.
  @param operation - Next private-state mutation.
  */
  private async runQueued(previous: Promise<void>, operation: () => Promise<void>) {
    const prior = await captureResult(previous);

    if (!prior.ok) {
      this.onError(prior.error);
    }

    await operation();
  }

  /** Group a changed active set while allowing incoming user work to preempt the provider call.
  @param session - Idle native Pi session.
  @param key - Current central credential.
  */
  private async process(session: AgentSession, key: string) {
    const controller = new AbortController();

    this.passController = controller;

    const grouped = await captureResult(() => this.groupAndCompact(session, key, controller.signal));

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

    await groupTaskContext(this.owner, this.state, (candidate, matched) => isSameTask(key, candidate, matched, signal));

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
    this.state.compactionPending = false;
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
      ingestTaskEntry(this.state, source);
    }

    this.state.sourceCursor = entry.id;
    await saveTaskState(this.owner, this.state);
  }

  /** Report an idle timer pass without rejecting the event loop callback.
  @param session - Session whose idle state controls grouping.
  */
  private async passWhenIdle(session: AgentSession) {
    const passed = await captureResult(() => this.pass(session));

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
    const synced = await captureResult(() =>
      this.enqueue(async () => {
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
      })
    );

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
    this.timer = setInterval(() => {
      scheduleTaskIndex(this.owner);

      if (session.isIdle) {
        void this.passWhenIdle(session);
      }
    }, PASS_INTERVAL_MS);
    this.timer.unref();
  }

  /** Process a changed idle chat with durable task checkpoints, retaining active context on classification failure.
  @param session - Pi session that owns the compaction operation.
  @returns Completion of one serialized changed-chat pass.
  */
  pass(session: AgentSession) {
    return this.enqueue(async () => {
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
    });
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
