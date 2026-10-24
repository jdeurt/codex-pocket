import { t as captureResult } from "try";
import { fork } from "node:child_process";
import path from "node:path";
import { log } from "./logging";
import { taskIndexReply, taskIndexRequest, type taskSearchPage } from "./task-index-protocol";
import { type z } from "zod";

const INDEX_TIMEOUT_MS = 90_000;
const SEARCH_TIMEOUT_MS = 25_000;
const COALESCE_MS = 250;
const ERROR_LENGTH = 2000;
const pending = new Map<string, { dirty: boolean; running: boolean; timer?: NodeJS.Timeout }>();

/** Run QMD outside the message-dispatch process so synchronous indexing and native inference cannot block it.
@param request - Validated parent-scoped index/search operation.
@returns A validated search page, or an actionable worker failure.
*/
function indexWorker(request: z.infer<typeof taskIndexRequest>): Promise<z.infer<typeof taskSearchPage>> {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(process.cwd(), "scripts/task-index.ts"), [], {
      execPath: process.execPath,
      execArgv: ["--import", path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new Error("Local QMD operation timed out."));
      },
      request.query === undefined ? INDEX_TIMEOUT_MS : SEARCH_TIMEOUT_MS
    );

    let errorText = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(-ERROR_LENGTH);
    });
    child.once("message", (message: unknown) => {
      clearTimeout(timer);
      const reply = taskIndexReply.safeParse(message);

      // QMD's tokenizer can own process-global native resources beyond the per-store lifecycle.
      // The complete result is already received; release this one-operation worker deterministically.
      child.kill();

      if (!reply.success) {
        reject(new Error("Invalid local QMD worker response."));
      } else if (reply.data.ok) {
        resolve(reply.data.page);
      } else {
        reject(new Error(reply.data.error));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Local QMD worker exited (${String(code)}): ${errorText}`));
    });
    child.send(request);
  });
}

/** Search with actual mode reporting, retrying through model-free QMD after optional inference crashes.
@param owner - Authorized Pocket parent.
@param query - Earlier-work query.
@param offset - Ranked passage offset.
@returns Search results plus mode and pagination metadata, including when no records match.
*/
export async function searchTaskArchivePage(owner: string, query: string, offset = 0) {
  const request = taskIndexRequest.parse({ owner, query, offset });

  const completed = await captureResult(indexWorker(request));

  if (completed.ok) {
    return completed.value;
  }

  const error = completed.error;

  const page = await indexWorker({ ...request, isKeywordOnly: true });

  page.retrieval.reasons.push(
    `Recovered using keyword-only QMD: ${error instanceof Error ? error.message : String(error)}`
  );

  return page;
}

/** Preserve the original array-returning search interface for existing internal callers.
@param owner - Authorized Pocket parent.
@param query - Earlier-work query.
@param offset - Optional result-page offset.
@returns QMD-ranked readable paths and source-backed excerpts.
*/
export async function searchTaskArchive(owner: string, query: string, offset = 0) {
  const page = await searchTaskArchivePage(owner, query, offset);

  return page.results;
}

/** Coalesce task-view changes without putting indexing on the user-message promise chain.
@param owner - Parent whose private index needs reconciliation.
*/
export function scheduleTaskIndex(owner: string) {
  const state = pending.get(owner) ?? { dirty: false, running: false };

  pending.set(owner, state);
  state.dirty = true;

  if (state.running || state.timer) {
    return;
  }

  async function reconcile() {
    state.timer = undefined;
    state.running = true;
    state.dirty = false;
    const indexed = await captureResult(indexWorker, { owner, offset: 0, isKeywordOnly: false });

    state.running = false;

    if (!indexed.ok) {
      log().warn({ error: indexed.error, owner }, "task.index_failed");
    }

    if (pending.get(owner)?.dirty) {
      scheduleTaskIndex(owner);
    } else {
      pending.delete(owner);
    }
  }

  state.timer = setTimeout(() => void reconcile(), COALESCE_MS);
  state.timer.unref();
}

/** Wait for scheduled background reconciliation during controlled shutdown or workflow verification.
@param owner - Parent whose outstanding background work must finish.
*/
export async function settleTaskIndex(owner: string) {
  while (pending.has(owner)) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, COALESCE_MS);
    });
  }
}
