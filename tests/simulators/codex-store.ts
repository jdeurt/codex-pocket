import { type Data, type Thread, object, string } from "../../src/lib/protocol";
import { CodexPersistence } from "./codex-persistence";
import { randomUUID } from "node:crypto";

const MILLISECONDS_PER_SECOND = 1000;

/**
Own durable simulator threads; a new transport can resume the same store without native installation.
*/
export class CodexStore {
  private persistence?: CodexPersistence;

  threads = new Map<string, Thread>();
  archived = new Set<string>();
  loaded = new Set<string>();

  /**
Load only the explicitly selected test state file.
@param filename - Optional isolated state file, never a native Codex home.
*/
  constructor(filename?: string) {
    this.persistence = filename ? new CodexPersistence(filename) : undefined;
    this.refresh();
  }

  /**
  Refresh sessions owned by other simulator processes before handling a request.
  */
  refresh() {
    this.persistence?.read(this.threads, this.archived, this.loaded);
  }

  /**
  Persist only changed sessions at each native request boundary.
  */
  save() {
    this.persistence?.write(this.threads, this.archived);
  }

  /**
Find a stored thread and reject unknown IDs.
@param id - Stable native-style identity.
@returns Stored thread.
*/
  get(id: unknown) {
    const thread = this.threads.get(string(id));

    if (!thread) {
      throw new Error(`thread not found: ${String(id)}`);
    }

    return thread;
  }

  /**
Create a native-shaped thread with deterministic policy and independent history.
@param params - Validated thread/start or fork parameters.
@returns Created thread.
*/
  create(params: Data) {
    const id = randomUUID();
    const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
    const thread: Thread = {
      id,
      sessionId: id,
      cwd: string(params.cwd) || process.cwd(),
      model: string(params.model) || "simulator-model",
      modelProvider: "openai",
      reasoningEffort: string(object(params.config).model_reasoning_effort) || "high",
      createdAt: now,
      updatedAt: now,
      preview: "",
      projectId: null,
      ephemeral: params.ephemeral === true,
      cliVersion: "0.163.0-alpha.10.2",
      source: "appServer",
      status: { type: "idle" },
      path: null,
      turns: [],
      name: null,
    };

    this.threads.set(id, thread);
    this.loaded.add(id);

    return thread;
  }
}

/**
Project startup/resume metadata with explicit native policy fields.
@param thread - Native-shaped simulator thread.
@returns Session response shared by start, fork and resume.
*/
export function sessionResponse(thread: Thread) {
  return {
    thread,
    model: thread.model,
    modelProvider: thread.modelProvider,
    reasoningEffort: thread.reasoningEffort,
    cwd: thread.cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

/**
Paginate immutable snapshots with opaque simulator-owned cursors.
@param values - Ordered rows.
@param params - Native page parameters.
@returns Stable page result.
*/
export function pageOf(values: unknown[], params: Data) {
  const offset = params.cursor ? Number(string(params.cursor).replace("sim:", "")) : 0;
  const limit = typeof params.limit === "number" ? params.limit : values.length;

  if (!Number.isSafeInteger(offset) || offset < 0 || limit < 1) {
    if (values.length === 0 && !params.cursor) {
      return { data: [], nextCursor: null };
    }

    throw new Error("Invalid simulator page cursor or limit");
  }

  return {
    data: structuredClone(values.slice(offset, offset + limit)),
    nextCursor: offset + limit < values.length ? `sim:${String(offset + limit)}` : null,
  };
}
