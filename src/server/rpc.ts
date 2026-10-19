import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type Data, object } from "../lib/protocol";
import type { Config } from "./config";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { log } from "./logging";
import { pocketServerArgs } from "./pocket-runtime";

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

  async connect(config: Config) {
    const args = pocketServerArgs(config);
    log().info({ binary: config.codexBinary, args, cwd: config.cwd, threadId: config.threadId }, "codex.spawn");
    this.child = spawn(config.codexBinary, args, { cwd: config.cwd, shell: false });
    const child = this.child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: Data;

      try {
        message = JSON.parse(line);
      } catch (error) {
        log().warn({ error, line }, "codex.stdout.invalid_json");

        return;
      }

      log().debug({ message }, "codex.rpc.in");

      if ("method" in message) {
        this.emit("event", {
          method: String(message.method),
          params: object(message.params),
          ...((typeof message.id === "string" || typeof message.id === "number") && { id: message.id }),
        });
      } else {
        const pending = this.pending.get(message.id as number);

        if (!pending) {
          return;
        }

        this.pending.delete(message.id as number);
        clearTimeout(pending.timer);
        log().debug(
          { method: pending.method, id: message.id, durationMs: Date.now() - pending.startedAt, error: message.error },
          "codex.rpc.acknowledged"
        );

        if (message.error) {
          const error = message.error as { message: string; code: number };
          pending.reject(new RpcError(error.message, error.code));
        } else {
          pending.resolve(message.result);
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
    child.once("exit", (code, signal) => close(new Error(`Codex disconnected: ${JSON.stringify({ code, signal })}`)));
    await this.request("initialize", {
      clientInfo: { name: "codex_pocket", title: "Pocket", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  request<T = unknown>(method: string, params: Data = {}): Promise<T> {
    if (!this.running) {
      return Promise.reject(new Error("Codex is not connected."));
    }

    const id = ++this.sequence;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        log().error({ method, id }, "codex.rpc.timeout");
        this.pending.delete(id);
        reject(
          new RpcError(`Codex did not acknowledge ${method}. Its outcome is unknown; check the thread before retrying.`)
        );
        // A late result cannot be safely associated with a subsequent send.
        this.close();
      }, ACKNOWLEDGEMENT_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, method, startedAt: Date.now() });
      this.write({ id, method, params });
    });
  }
  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }
  close() {
    this.child?.kill("SIGTERM");
  }
}
