import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { t } from "try";
import { taskIndexReply, type taskIndexRequest, type taskSearchPage } from "./protocol";
import { type z } from "zod";

const INDEX_TIMEOUT_MS = 90_000;
const SEARCH_TIMEOUT_MS = 25_000;
const ERROR_LENGTH = 2000;

type IndexRequest = z.infer<typeof taskIndexRequest>;
type SearchPage = z.infer<typeof taskSearchPage>;

/**
Runtime owner of one isolated native QMD process and its completion.
*/
class IndexWorker {
  private readonly completion = Promise.withResolvers<SearchPage>();
  private readonly child: ChildProcess;
  private readonly timer: ReturnType<typeof setTimeout>;
  private errorText = "";
  private hasSettled = false;

  /** Reject native execution and terminate its process.
  @param error - Original transport/process failure.
  */
  private fail = (error: unknown) => {
    if (this.hasSettled) {
      return;
    }

    this.release();
    this.completion.reject(error);
  };

  /**
  Terminate native inference after its bounded deadline.
  */
  private timedOut = () => {
    this.child.kill("SIGKILL");
    this.fail(new Error("Local QMD operation timed out."));
  };

  /** Retain bounded native stderr for a failed worker.
  @param chunk - Native stderr bytes.
  */
  private stderr = (chunk: Buffer) => {
    this.errorText = (this.errorText + chunk.toString()).slice(-ERROR_LENGTH);
  };

  /** Validate the completed native response before releasing process-global resources.
  @param message - Native IPC response.
  */
  private message = (message: unknown) => {
    if (this.hasSettled) {
      return;
    }

    const reply = taskIndexReply.safeParse(message);

    if (!reply.success) {
      this.fail(new Error("Invalid local QMD worker response."));
    } else if (reply.data.ok) {
      this.release();
      this.completion.resolve(reply.data.page);
    } else {
      this.fail(new Error(reply.data.error));
    }
  };

  /** Report premature native process exit with retained diagnostic evidence.
  @param code - Native exit status.
  */
  private exited = (code: number | null) => {
    this.fail(new Error(`Local QMD worker exited (${String(code)}): ${this.errorText}`));
  };

  /** Send the validated request through the owned IPC channel.
  @param request - Explicit parent-scoped request.
  */
  private send = (request: IndexRequest) => {
    this.child.send(request);
  };

  readonly result = this.completion.promise;

  /** Launch one process and bind its bounded lifecycle to the caller's request.
  @param request - Validated parent-scoped operation.
  */
  constructor(request: IndexRequest) {
    this.child = fork(path.join(process.cwd(), "scripts/task-index.ts"), [], {
      execPath: process.execPath,
      execArgv: ["--import", path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.timer = setTimeout(this.timedOut, request.query === undefined ? INDEX_TIMEOUT_MS : SEARCH_TIMEOUT_MS);
    this.child.stderr?.on("data", this.stderr);
    this.child.once("message", this.message);
    this.child.on("error", this.fail);
    this.child.once("exit", this.exited);
    const sent = t(this.send, request);

    if (!sent.ok) {
      this.fail(sent.error);
    }
  }

  /**
  Finish an owned process exactly once before settling its caller.
  */
  private release() {
    this.hasSettled = true;
    clearTimeout(this.timer);
    this.child.kill();
  }
}

/** Run QMD outside the message-dispatch process so indexing cannot block the conversation.
@param request - Validated parent-scoped operation.
@returns Validated search page or the original native worker failure.
*/
export function indexWorker(request: IndexRequest): Promise<SearchPage> {
  return new IndexWorker(request).result;
}
