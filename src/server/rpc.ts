import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type Data, object, rpcEventSchema, string } from "../lib/protocol";
import {
  type SessionResponse,
  type configResponseSchema,
  type itemsPageSchema,
  rpcResponseSchemas,
  type threadResponseSchema,
  type threadsPageSchema,
  type turnResponseSchema,
  type turnsPageSchema,
} from "./rpc-protocol";
import { type Config } from "./config";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { log } from "./logging";
import { pocketServerArgs } from "./pocket-runtime";
import { waitForProcessExit } from "./harness/process";
import { type z } from "zod";

const ACKNOWLEDGEMENT_TIMEOUT_MS = 90_000;

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number
  ) {
    super(message);
  }
}

// One process, one newline-delimited JSON-RPC connection. Never spawn a shell.
export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      method: string;
      startedAt: number;
    }
  >();
  private write(message: unknown) {
    log().debug({ message }, "codex.rpc.out");
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }
  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }
  get pid() {
    return this.child?.pid;
  }

  async connect(config: Config, profile: "pocket" | "bare" = "pocket") {
    const args = profile === "pocket" ? pocketServerArgs(config) : config.serverArgs;
    log().info({ binary: config.codexBinary, args, cwd: config.cwd, threadId: config.threadId }, "codex.spawn");
    this.child = spawn(config.codexBinary, args, { cwd: config.cwd, shell: false });
    const child = this.child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: Data;

      try {
        message = object(JSON.parse(line));
      } catch (error) {
        log().warn({ error, line }, "codex.stdout.invalid_json");

        return;
      }

      log().debug({ message }, "codex.rpc.in");

      if ("method" in message) {
        const event = rpcEventSchema.safeParse(message);

        if (!event.success) {
          log().warn({ error: event.error }, "codex.rpc.invalid_event");

          return;
        }

        this.emit("event", event.data);
      } else {
        const id = message.id;

        if (typeof id !== "number") {
          return;
        }

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
        } else {
          try {
            const schema = rpcResponseSchemas.get(pending.method);
            pending.resolve(schema ? schema.parse(message.result) : message.result);
          } catch (error) {
            pending.reject(new Error(`Invalid ${pending.method} response.`, { cause: error }));
          }
        }
      }
    });
    child.stderr.on("data", (data) => this.emit("diagnostic", String(data)));
    let closed = false;
    const close = (error: Error) => {
      if (closed) {
        return;
      }

      closed = true;
      log().error({ error }, "codex.disconnected");
      lines.close();

      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }

      this.pending.clear();
      this.child = undefined;
      this.emit("disconnect", error);
    };
    child.once("error", close);
    child.once("exit", (code, signal) => {
      close(new Error(`Codex disconnected: ${JSON.stringify({ code, signal })}`));
    });
    await this.request("initialize", {
      clientInfo: { name: "codex_pocket", title: "Pocket", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  request(method: "thread/start" | "thread/resume", params?: Data): Promise<SessionResponse>;
  request(method: "thread/read", params?: Data): Promise<z.infer<typeof threadResponseSchema>>;
  request(method: "turn/start", params?: Data): Promise<z.infer<typeof turnResponseSchema>>;
  request(method: "config/read", params?: Data): Promise<z.infer<typeof configResponseSchema>>;
  request(method: "thread/list", params?: Data): Promise<z.infer<typeof threadsPageSchema>>;
  request(method: "thread/turns/list", params?: Data): Promise<z.infer<typeof turnsPageSchema>>;
  request(method: "thread/items/list", params?: Data): Promise<z.infer<typeof itemsPageSchema>>;
  request(method: string, params?: Data): Promise<unknown>;
  request(method: string, params: Data = {}): Promise<unknown> {
    if (!this.running) {
      return Promise.reject(new Error("Codex is not connected."));
    }

    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
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
  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }
  close() {
    this.child?.kill("SIGTERM");
  }
  async shutdown() {
    const child = this.child;
    this.close();
    await waitForProcessExit(child);
  }
}

// Inspection must use an existing live transport, without connecting/resuming it.
export function requireConnectedRpc(rpc: CodexRpc | undefined, connected: boolean): CodexRpc {
  if (!rpc?.running || !connected) {
    throw new Error("Harness inspection is disconnected.");
  }

  return rpc;
}
