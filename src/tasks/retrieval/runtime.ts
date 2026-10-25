import { t } from "try";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "../../server/logging";
import { taskIndexRequest } from "./protocol";
import { indexWorker } from "./worker";

const COALESCE_MS = 250;

/** Search with actual mode reporting and an explicit model-free recovery outcome.
@param owner - Authorized Pocket parent.
@param query - Earlier-work query.
@param offset - Ranked passage offset.
@returns Source-validated results with actual retrieval mode and recovery evidence.
*/
export async function searchTaskArchivePage(owner: string, query: string, offset = 0) {
  const request = taskIndexRequest.parse({ owner, query, offset });
  const completed = await t(indexWorker, request);

  if (completed.ok) {
    return completed.value;
  }

  const error = completed.error;
  const recovered = await t(indexWorker, { ...request, isKeywordOnly: true });

  if (!recovered.ok) {
    throw new AggregateError([error, recovered.error], "Task search and keyword recovery both failed.");
  }

  const page = recovered.value;

  return {
    ...page,
    retrieval: {
      ...page.retrieval,
      reasons: [
        ...page.retrieval.reasons,
        `Recovered using keyword-only QMD: ${error instanceof Error ? error.message : String(error)}`,
      ],
    },
  };
}

/** Preserve the array-returning search interface for existing callers.
@param owner - Authorized Pocket parent.
@param query - Earlier-work query.
@param offset - Ranked passage offset.
@returns Ranked source-backed results.
*/
export async function searchTaskArchive(owner: string, query: string, offset = 0) {
  const page = await searchTaskArchivePage(owner, query, offset);

  return page.results;
}

/**
Runtime owner of one parent's coalesced background indexing lifetime.
*/
class BackgroundIndex {
  private isDirty = false;
  private isRunning = false;
  private timer?: ReturnType<typeof setTimeout>;

  /**
  Run the pending index and retain wakeups received during execution.
  */
  private reconcile = async () => {
    this.timer = undefined;
    this.isRunning = true;
    this.isDirty = false;
    const indexed = await t(indexWorker, { owner: this.owner, offset: 0, isKeywordOnly: false });

    if (!indexed.ok) {
      log().warn({ error: indexed.error, owner: this.owner }, "task.index_failed");
    }

    this.finish();
  };

  /**
  Read wakeups received during native work before releasing this job.
  */
  private finish = () => {
    this.isRunning = false;

    if (this.isDirty) {
      this.schedule();
    } else {
      this.finished(this.owner);
    }
  };

  /**
  Enter asynchronous indexing from the native timer.
  */
  private start = () => {
    void this.reconcile();
  };

  /**
  Coalesce another archive write into this parent's next native index run.
  */
  schedule = () => {
    this.isDirty = true;

    if (this.isRunning || this.timer) {
      return;
    }

    this.timer = setTimeout(this.start, COALESCE_MS);
    this.timer.unref();
  };

  /** Retain explicit parent and completion ownership.
  @param owner - Parent identity.
  @param finished - Scheduler's removal action.
  */
  constructor(
    private readonly owner: string,
    private readonly finished: (owner: string) => void
  ) {}
}

/**
Process runtime owner of background jobs, separate from conversational state.
*/
class TaskIndexScheduler {
  private readonly pending = new Map<string, BackgroundIndex>();
  /** Release a completed parent's job.
  @param owner - Completed parent identity.
  */
  private finished = (owner: string) => {
    this.pending.delete(owner);
  };

  /** Retain one coalescing owner per active parent.
  @param owner - Parent whose archive changed.
  */
  schedule = (owner: string) => {
    const job = this.pending.get(owner) ?? new BackgroundIndex(owner, this.finished);

    this.pending.set(owner, job);
    job.schedule();
  };

  /** Await background reconciliation during controlled shutdown or verification.
  @param owner - Parent whose pending work must finish.
  */
  settle = async (owner: string) => {
    while (this.pending.has(owner)) {
      await delay(COALESCE_MS);
    }
  };
}

const scheduler = new TaskIndexScheduler();
export const scheduleTaskIndex = scheduler.schedule;
export const settleTaskIndex = scheduler.settle;
