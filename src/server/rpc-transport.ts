import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { RpcDiagnosticEvent, RpcDisconnectEvent } from "./rpc-events";
import WebSocket, { type RawData } from "ws";
import { type Config } from "./config";
import { createInterface } from "node:readline";
import { log } from "./logging";
import { once } from "node:events";
import { pocketServerArgs } from "./pocket-runtime";
import path from "node:path";
import { waitForProcessExit } from "./harness/process";

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
Decode all WebSocket library frame representations as UTF-8 protocol text.
@param data - Complete library frame data.
@returns Native JSON text for the protocol boundary.
*/
export function socketText(data: RawData) {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
}

/**
Carry one complete JSON frame from either native transport.
*/
export class RpcLineEvent extends Event {
  /**
  Preserve a complete frame for protocol decoding.
  @param line - Complete native JSON frame.
  */
  constructor(readonly line: string) {
    super("line");
  }
}

/**
Own an isolated subprocess or a connection to an externally owned server.
*/
export class RpcTransport extends EventTarget {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private disconnected = false;

  /**
  Publish terminal failure once, regardless of overlapping error and close events.
  @param error - Original connection failure.
  */
  private disconnect(error: Error) {
    if (this.disconnected) {
      return;
    }

    this.disconnected = true;
    log().error({ error }, "codex.disconnected");
    this.dispatchEvent(new RpcDisconnectEvent(error));
  }

  /**
  Bind stdout and process lifetime before initialization is sent.
  @param child - Owned subprocess with piped streams.
  */
  private observe(child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => this.dispatchEvent(new RpcLineEvent(line)));
    child.stderr.on("data", (data: unknown) => this.dispatchEvent(new RpcDiagnosticEvent(String(data))));
    child.once("error", (error) => {
      this.disconnect(error);
    });
    child.once("exit", (code, signal) => {
      lines.close();
      this.disconnect(new Error(`Codex disconnected: ${JSON.stringify({ code, signal })}`));
    });
  }

  /**
  Start an owned stdio server with the requested native configuration.
  @param config - Native binary, arguments and working directory.
  @param profile - Whether to install the main Pocket tools.
  */
  connect(config: Config, profile: "pocket" | "bare" | "pi") {
    const isOfflineReplay = process.env.POCKET_TEST_MAIN_HARNESS === "codex" && config.codexBinary === process.execPath;

    if (profile === "pi" && !isOfflineReplay) {
      this.disconnected = false;
      this.socket = undefined;
      this.child = spawn(
        process.execPath,
        [
          "--import",
          path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
          path.join(process.cwd(), "scripts/pi-main.ts"),
        ],
        {
          cwd: process.cwd(),
          shell: false,
          env: { ...process.env, POCKET_PI_CONFIG: JSON.stringify(config) },
        }
      );
      this.observe(this.child);

      return;
    }

    const args = profile === "bare" ? config.serverArgs : pocketServerArgs(config);

    this.disconnected = false;
    this.socket = undefined;
    log().info({ binary: config.codexBinary, args, cwd: config.cwd, threadId: config.threadId }, "codex.spawn");
    this.child = spawn(config.codexBinary, args, { cwd: config.cwd, shell: false });
    this.observe(this.child);
  }

  /**
  Connect to a local owning server without starting or taking ownership of it.
  @param filename - Absolute Unix socket path, validated by the adoption boundary.
  */
  async connectSocket(filename: string) {
    const socket = new WebSocket(`ws+unix://${filename}:`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });

    this.disconnected = false;
    this.child = undefined;
    this.socket = socket;
    socket.on("message", (data) => this.dispatchEvent(new RpcLineEvent(socketText(data))));
    socket.on("error", (error) => {
      this.disconnect(error);
    });
    socket.once("close", () => {
      this.disconnect(new Error("The owning Codex server disconnected."));
    });
    await once(socket, "open");
  }

  /**
  Check the connected resource before sending.
  @returns Whether this transport can accept a native request.
  */
  get running() {
    return (
      !this.disconnected &&
      (this.socket
        ? this.socket.readyState === WebSocket.OPEN
        : !!this.child && this.child.exitCode === null && !this.child.killed)
    );
  }

  /**
  Expose only processes owned by this transport.
  @returns The owned process ID; external servers never become owned children.
  */
  get pid() {
    return this.child?.pid;
  }

  /**
  Write one complete native frame through the connected transport.
  @param message - JSON protocol envelope.
  */
  write(message: unknown) {
    const text = JSON.stringify(message);

    if (this.socket) {
      this.socket.send(text);
    } else {
      this.child?.stdin.write(text + "\n");
    }
  }

  /**
  Close only the resources this transport owns.
  */
  close() {
    this.socket?.terminate();
    this.child?.kill("SIGTERM");
  }

  /**
  Wait for the owned process or socket to finish closing.
  */
  async shutdown() {
    const closed = this.socket && this.socket.readyState !== WebSocket.CLOSED ? once(this.socket, "close") : undefined;

    this.close();
    await closed;
    await waitForProcessExit(this.child);
  }
}
