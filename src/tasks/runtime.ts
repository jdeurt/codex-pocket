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

const NOT_FOUND = -1;
const PASS_INTERVAL_MS = 600_000;

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

  /** Run semantic interpretation only at an idle effect boundary; completion never changes work state.
  @param session - Native session used for scheduling only.
  */
  private async classify(session: AgentSession) {
    if (!session.isIdle) {
      return;
    }

    const key = await this.readKey();

    if (!key) {
      return;
    }

    const controller = new AbortController();

    this.passController = controller;
    const classified = await t(classifyTaskLedger, this.owner, key, controller.signal);

    this.passController = undefined;

    if (!classified.ok && !controller.signal.aborted) {
      this.onError(classified.error);
    }

    await regenerateTaskProjections(this.owner);
    scheduleTaskIndex(this.owner);
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
  }

  /** Restore ledger state and conservative legacy membership before accepting new native work.
  @param manager - Native persistence owner.
  @param session - Native session whose idle state gates classification.
  */
  async start(manager: SessionManager, session: AgentSession) {
    await migrateTaskLedger(this.owner);
    await this.sync(manager);
    await this.flush();
    await regenerateTaskProjections(this.owner);
    this.timer = setInterval(this.tick.bind(this, session), PASS_INTERVAL_MS);
    this.timer.unref();
  }

  /** Schedule one serialized idle interpretation, independently of context compaction.
  @param session - Native session.
  @returns Completion of the background pass.
  */
  pass(session: AgentSession) {
    this.serial = this.queue.run(this.classify.bind(this, session));

    return this.serial;
  }

  /**
  Give newly accepted work priority over provider interpretation.
  */
  interrupt() {
    this.passController?.abort();
  }

  /** Wait for current source persistence and background work.
  @returns Completion, propagating source and persistence failures.
  */
  async flush() {
    await this.serial;
  }

  /** Stop owned background resources and finish pending persistence.
  @returns Completion of shutdown.
  */
  async stop() {
    clearInterval(this.timer);
    this.interrupt();
    await this.flush();
  }
}
