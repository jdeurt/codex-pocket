import type { Bridge } from "./bridge-session";
import type { Snapshot } from "../lib/protocol";
import { delegations } from "./delegations";
import { log } from "./logging";
import { noStore } from "./http";
import { visibleSnapshot } from "./visible-snapshot";

const HEARTBEAT_MS = 15_000;

/**
Own one browser's parent snapshot subscription and its HTTP stream lifetime.
*/
export class SnapshotStream {
  private readonly encoder = new TextEncoder();

  private readonly connectionId = crypto.randomUUID();

  private controller?: ReadableStreamDefaultController<Uint8Array>;

  private heartbeat?: NodeJS.Timeout;

  private isClosed = false;

  private unsubscribeReports?: () => void;

  private readonly stream: ReadableStream<Uint8Array>;

  /**
  Remove this subscription when its HTTP request aborts.
  */
  private readonly abort = () => {
    this.close(true);
  };

  /**
  Read canonical state when the publisher signals an update across Next entry points.
  */
  private readonly changed = () => {
    this.send(this.bridge.snapshot);
  };

  /**
  Bind a browser request to the parent bridge's existing snapshot publisher.
  @param request - Browser request supplying cancellation and diagnostics.
  @param bridge - Existing parent bridge; no additional connection is created.
  */
  constructor(
    private request: Request,
    private bridge: Bridge
  ) {
    log().info({ connectionId: this.connectionId, userAgent: request.headers.get("user-agent") }, "sse.open");
    this.stream = new ReadableStream({
      start: (controller) => {
        this.start(controller);
      },
      cancel: () => {
        this.close(false);
      },
    });
  }

  /**
  Project private canonical state before encoding one browser snapshot record.
  @param state - Canonical parent state.
  @returns Encoded server-sent event containing only visible state.
  */
  private encoded(state: Snapshot) {
    const visible = visibleSnapshot(state, {
      reports: state.threadId ? delegations().reports.list(state.threadId) : [],
    });

    return this.encoder.encode(`data: ${JSON.stringify(visible)}\n\n`);
  }

  /**
  Send a snapshot while this HTTP stream remains open.
  @param state - Canonical state to project for the browser.
  */
  private send(state: Snapshot) {
    if (this.isClosed) {
      return;
    }

    this.controller?.enqueue(this.encoded(state));
  }

  /**
  Start heartbeat and native subscriptions before publishing initial state.
  @param controller - Controller owned by this HTTP stream.
  */
  private start(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.controller = controller;
    this.heartbeat = setInterval(() => {
      if (!this.isClosed) {
        controller.enqueue(this.encoder.encode(": keepalive\n\n"));
      }
    }, HEARTBEAT_MS);
    this.bridge.snapshots.addEventListener("snapshot", this.changed);
    this.unsubscribeReports = delegations().subscribe(this.changed);
    this.request.signal.addEventListener("abort", this.abort, { once: true });
    this.send(this.bridge.snapshot);
    void this.bridge
      .ensureConnected()
      .then(() => {
        this.send(this.bridge.snapshot);
      })
      .catch(() => {
        this.send(this.bridge.snapshot);
      });
  }

  /**
  Release heartbeat and subscriptions once, optionally closing the producer.
  @param shouldCloseStream - Whether request abort requires producer closure.
  */
  private close(shouldCloseStream: boolean) {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    log().info({ connectionId: this.connectionId }, "sse.closed");
    clearInterval(this.heartbeat);
    this.unsubscribeReports?.();
    this.bridge.snapshots.removeEventListener("snapshot", this.changed);
    this.request.signal.removeEventListener("abort", this.abort);

    if (shouldCloseStream) {
      this.controller?.close();
    }
  }

  /**
  Expose this subscription with streaming and private-cache headers.
  @returns HTTP response carrying the parent event stream.
  */
  response() {
    return new Response(this.stream, {
      headers: {
        ...noStore,
        "Cache-Control": "no-store, no-transform",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
