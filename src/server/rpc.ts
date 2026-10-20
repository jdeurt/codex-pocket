import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type Data, object, rpcEventSchema, string } from "../lib/protocol";
import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "./rpc-events";
import {
  RpcError,
  type SessionResponse,
  type configResponseSchema,
  decodeRpcLine,
  type itemsPageSchema,
  rpcResponseSchemas,
  type threadResponseSchema,
  type threadsPageSchema,
  type turnResponseSchema,
  type turnsPageSchema,
} from "./rpc-protocol";
import { type Config } from "./config";
import { createInterface } from "node:readline";
import { log } from "./logging";
import { pocketServerArgs } from "./pocket-runtime";
import { waitForProcessExit } from "./harness/process";
import { type z } from "zod";

export { RpcError } from "./rpc-protocol";

const ACKNOWLEDGEMENT_TIMEOUT_MS = 90_000;

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
}

// One process, one newline-delimited JSON-RPC connection. Never spawn a shell.
/**
Own one child process and its newline-delimited JSON-RPC connection.
*/
export class CodexRpc extends EventTarget {
  private child?: ChildProcessWithoutNullStreams;

  private sequence = 0;

  private pending = new Map<number, PendingResponse>();

  /**
  Log and write one native protocol message without spawning a shell.
  @param message - Protocol request, response or notification.
  */
  private write(message: unknown) {
    log().debug({ message }, "codex.rpc.out");
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }

  /**
  Start the configured native transport and retain its process handle.
  @param config - Validated native launch configuration.
  @param profile - Whether Pocket's native server arguments are required.
  @returns The spawned native child with piped streams.
  */
  private spawn(config: Config, profile: "pocket" | "bare") {
    const args = profile === "pocket" ? pocketServerArgs(config) : config.serverArgs;

    log().info({ binary: config.codexBinary, args, cwd: config.cwd, threadId: config.threadId }, "codex.spawn");
    this.child = spawn(config.codexBinary, args, { cwd: config.cwd, shell: false });

    return this.child;
  }

  /**
  Validate an unsolicited native message before delivering it to subscribers.
  @param message - Decoded object containing a protocol method.
  */
  private notification(message: Data) {
    const event = rpcEventSchema.safeParse(message);

    if (!event.success) {
      log().warn({ error: event.error }, "codex.rpc.invalid_event");

      return;
    }

    this.dispatchEvent(new RpcNotificationEvent(event.data));
  }

  /**
  Validate a known method response before settling its pending request.
  @param pending - Acknowledgement owner already removed from the pending map.
  @param value - Untrusted native result value.
  */
  private result(pending: PendingResponse, value: unknown) {
    const schema = rpcResponseSchemas.get(pending.method);

    if (!schema) {
      pending.resolve(value);

      return;
    }

    try {
      pending.resolve(schema.parse(value));
    } catch (error) {
      pending.reject(new Error(`Invalid ${pending.method} response.`, { cause: error }));
    }
  }

  /**
  Consume one matching acknowledgement and retain its native error or result.
  @param id - Numeric request identity from the decoded response.
  @param message - Decoded native response object.
  */
  private response(id: number, message: Data) {
    const pending = this.pending.get(id);

    if (!pending) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timer);
    log().debug(
      { method: pending.method, id: message.id, durationMs: Date.now() - pending.startedAt, error: message.error },
      "codex.rpc.acknowledged"
    );

    if (message.error) {
      const error = object(message.error);

      pending.reject(new RpcError(string(error.message), typeof error.code === "number" ? error.code : undefined));

      return;
    }

    this.result(pending, message.result);
  }

  /**
  Route a decoded native stdout line to notification or response handling.
  @param line - Complete native stdout line.
  */
  private line(line: string) {
    const message = decodeRpcLine(line);

    if (!message) {
      return;
    }

    log().debug({ message }, "codex.rpc.in");

    if ("method" in message) {
      this.notification(message);
    } else if (typeof message.id === "number") {
      this.response(message.id, message);
    }
  }

  /**
  Bind stdout, stderr and terminal process events to one idempotent connection lifetime.
  @param child - Native process owned by this connection.
  */
  private observe(child: ChildProcessWithoutNullStreams) {
    let isClosed = false;

    const lines = createInterface({ input: child.stdout });
    const close = (error: Error) => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      log().error({ error }, "codex.disconnected");
      lines.close();

      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }

      this.pending.clear();
      this.child = undefined;
      this.dispatchEvent(new RpcDisconnectEvent(error));
    };

    lines.on("line", (line) => {
      this.line(line);
    });
    child.stderr.on("data", (data: unknown) => this.dispatchEvent(new RpcDiagnosticEvent(String(data))));
    child.once("error", close);
    child.once("exit", (code, signal) => {
      close(new Error(`Codex disconnected: ${JSON.stringify({ code, signal })}`));
    });
  }

  /**
  Allocate an identity and reject uncertain requests when acknowledgement expires.
  @param method - Native JSON-RPC method.
  @param params - Native request parameters.
  @returns The acknowledged native result.
  */
  private pendingRequest(method: string, params: Data) {
    const id = ++this.sequence;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        log().error({ method, id }, "codex.rpc.timeout");
        this.pending.delete(id);
        reject(
          new RpcError(`Codex did not acknowledge ${method}. Its outcome is unknown; check the thread before retrying.`)
        );
        // A late result cannot be safely associated with a subsequent send.
        this.close();
      }, ACKNOWLEDGEMENT_TIMEOUT_MS);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        startedAt: Date.now(),
      });
      this.write({ id, method, params });
    });
  }

  /**
  Check whether the native child still accepts requests.
  @returns Whether this connection has a live child.
  */
  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /**
  Expose the current native child identity for process supervision.
  @returns The native process ID while connected.
  */
  get pid() {
    return this.child?.pid;
  }

  /**
  Observe the native child before performing the initialization handshake.
  @param config - Validated native launch configuration.
  @param profile - Whether to include Pocket's native server arguments.
  */
  async connect(config: Config, profile: "pocket" | "bare" = "pocket") {
    const child = this.spawn(config, profile);

    this.observe(child);
    await this.request("initialize", {
      clientInfo: { name: "codex_pocket", title: "Pocket", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  /**
  Create or resume a native session with its effective model and reasoning effort.
  @param method - Native session creation or resume method.
  @param params - Native request parameters.
  @returns Validated session, model and nullable reasoning effort.
  */
  request(method: "thread/start" | "thread/resume", params?: Data): Promise<SessionResponse>;
  /**
  Read a native thread using its canonical protocol response.
  @param method - Native thread-read method.
  @param params - Native request parameters.
  @returns Validated thread metadata and any supplied turns.
  */
  request(method: "thread/read", params?: Data): Promise<z.infer<typeof threadResponseSchema>>;
  /**
  Start a native turn and validate the returned turn identity.
  @param method - Native turn-start method.
  @param params - Native request parameters.
  @returns Validated native turn response.
  */
  request(method: "turn/start", params?: Data): Promise<z.infer<typeof turnResponseSchema>>;
  /**
  Read effective native configuration while retaining forward-compatible settings.
  @param method - Native configuration-read method.
  @param params - Native request parameters.
  @returns Validated effective configuration object.
  */
  request(method: "config/read", params?: Data): Promise<z.infer<typeof configResponseSchema>>;
  /**
  Read one native thread page and its continuation cursor.
  @param method - Native thread-list method.
  @param params - Native request parameters.
  @returns Validated thread entries and nullable continuation cursor.
  */
  request(method: "thread/list", params?: Data): Promise<z.infer<typeof threadsPageSchema>>;
  /**
  Read one native turn page without dropping deferred-item metadata.
  @param method - Native turn-list method.
  @param params - Native request parameters.
  @returns Validated chronological turns and nullable continuation cursor.
  */
  request(method: "thread/turns/list", params?: Data): Promise<z.infer<typeof turnsPageSchema>>;
  /**
  Read one native item page using canonical item wrappers.
  @param method - Native item-list method.
  @param params - Native request parameters.
  @returns Validated item entries and nullable continuation cursor.
  */
  request(method: "thread/items/list", params?: Data): Promise<z.infer<typeof itemsPageSchema>>;
  /**
  Send a forward-compatible native request whose result schema is unregistered.
  @param method - Native JSON-RPC method.
  @param params - Native request parameters.
  @returns Unknown native result requiring caller-side interpretation.
  */
  request(method: string, params?: Data): Promise<unknown>;
  /**
  Dispatch a native request only while its child connection remains live.
  @param method - Native JSON-RPC method.
  @param params - Native request parameters.
  @returns Method-validated response, or unknown result for an unregistered method.
  */
  request(method: string, params: Data = {}): Promise<unknown> {
    return this.running ? this.pendingRequest(method, params) : Promise.reject(new Error("Codex is not connected."));
  }

  /**
  Answer a native server request using its original identity.
  @param id - Native server request identity.
  @param result - Validated answer produced by the request adapter.
  */
  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }

  /**
  Request termination of the current native child.
  */
  close() {
    this.child?.kill("SIGTERM");
  }

  /**
  Terminate the current child and await its observed process exit.
  */
  async shutdown() {
    const child = this.child;

    this.close();
    await waitForProcessExit(child);
  }
}
