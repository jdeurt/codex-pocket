import { type Data, object, realtimeItemAddedSchema, rpcEventSchema, string } from "../lib/protocol";
import { RpcDiagnosticEvent, RpcDisconnectEvent, RpcNotificationEvent } from "./rpc-events";
import {
  type SessionResponse,
  type configResponseSchema,
  decodeRpcLine,
  type itemsPageSchema,
  type threadResponseSchema,
  type threadsPageSchema,
  type turnResponseSchema,
  type turnsPageSchema,
} from "./rpc-protocol";
import { RpcLineEvent, RpcTransport } from "./rpc-transport";
import { type Config } from "./config";
import { log } from "./logging";
import { type z } from "zod";
import { RpcAcknowledgements } from "./rpc-acknowledgements";

export { RpcError } from "./rpc-protocol";

// One owned JSON-RPC connection, over stdio or the existing owner's Unix socket.
/**
Correlate validated native requests over one owned connection.
*/
export class CodexRpc extends EventTarget {
  private transport = new RpcTransport();

  private acknowledgements = new RpcAcknowledgements(this.write.bind(this), this.close.bind(this));

  /** Decode complete frames from the owned transport.
  @param event - Native frame event.
  */
  private received = (event: Event) => {
    if (event instanceof RpcLineEvent) {
      this.line(event.line);
    }
  };

  /** Forward transport diagnostics without sharing the original event object.
  @param event - Native diagnostic event.
  */
  private diagnostic = (event: Event) => {
    if (event instanceof RpcDiagnosticEvent) {
      this.dispatchEvent(new RpcDiagnosticEvent(event.text));
    }
  };

  /** Reject every outstanding acknowledgement when its transport disconnects.
  @param event - Native terminal event.
  */
  private disconnected = (event: Event) => {
    if (!(event instanceof RpcDisconnectEvent)) {
      return;
    }

    this.acknowledgements.fail(event.error);
    this.dispatchEvent(new RpcDisconnectEvent(event.error));
  };

  /**
  Bind transport frames and failures before opening any native connection.
  */
  constructor() {
    super();
    this.transport.addEventListener("line", this.received);
    this.transport.addEventListener("diagnostic", this.diagnostic);
    this.transport.addEventListener("disconnect", this.disconnected);
  }

  /**
  Write one native protocol message through the owned connection.
  @param message - Protocol request, response or notification.
  */
  private write(message: unknown) {
    // Realtime frames contain microphone audio and private speech. Never log their payloads.
    if (!string(object(message).method).startsWith("thread/realtime/")) {
      log().debug({ message }, "codex.rpc.out");
    }

    this.transport.write(message);
  }

  /**
  Validate an unsolicited native message before delivering it to subscribers.
  @param message - Decoded object containing a protocol method.
  */
  private notification(message: Data) {
    const event = (message.method === "thread/realtime/itemAdded" ? realtimeItemAddedSchema : rpcEventSchema).safeParse(
      message
    );

    if (!event.success) {
      log().warn({ error: event.error }, "codex.rpc.invalid_event");

      return;
    }

    this.dispatchEvent(new RpcNotificationEvent(event.data));
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

    if ("method" in message) {
      if (!string(message.method).startsWith("thread/realtime/")) {
        log().debug({ message }, "codex.rpc.in");
      }

      this.notification(message);
    } else if (typeof message.id === "number") {
      this.acknowledgements.response(message.id, message);
    }
  }

  /**
  Initialize a connected native protocol client.
  */
  private async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "codex_pocket", title: "Pocket", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  /**
  Check whether the native child still accepts requests.
  @returns Whether this connection has a live child.
  */
  get running() {
    return this.transport.running;
  }

  /**
  Expose the current native child identity for process supervision.
  @returns The native process ID while connected.
  */
  get pid() {
    return this.transport.pid;
  }

  /**
  Observe the native child before performing the initialization handshake.
  @param config - Validated native launch configuration.
  @param profile - Whether to include Pocket's native server arguments.
  */
  async connect(config: Config, profile: "pocket" | "bare" | "pi" = "pocket") {
    this.transport.connect(config, profile);
    await this.initialize();
  }

  /**
  Attach to an external app-server over its existing local Unix socket.
  @param filename - Absolute socket path owned by that server.
  */
  async connectSocket(filename: string) {
    await this.transport.connectSocket(filename);
    await this.initialize();
  }

  /** Create or resume a native session with its effective model and reasoning effort.
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
    return this.running
      ? this.acknowledgements.request(method, params)
      : Promise.reject(new Error("Codex is not connected."));
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
    this.transport.close();
  }

  /**
  Terminate the current child and await its observed process exit.
  */
  async shutdown() {
    await this.transport.shutdown();
  }
}
