import { t } from "try";
import type { Bridge } from "./bridge-session";
import { delegations } from "./delegations";
import { log } from "./logging";
import { noStore } from "./http";
import { visibleSnapshot } from "../state/visible-snapshot";
import { TextStream } from "./text-stream";
import { valueAfterCleanup } from "../lib/results";

const HEARTBEAT_MS = 15_000;

/**
Own a browser snapshot subscription while TextStream owns transport and cancellation.
*/
export class SnapshotStream {
  private readonly connectionId = crypto.randomUUID();
  private text?: TextStream;
  private unsubscribeReports?: () => void;

  /**
  Read and project canonical state only while the subscriber remains active.
  */
  private readonly changed = () => {
    const state = this.bridge.snapshot;
    const visible = visibleSnapshot(state, {
      tools: true,
      reports: state.threadId ? delegations().reports.list(state.threadId) : [],
    });

    this.text?.send(`data: ${JSON.stringify(visible)}\n\n`);
  };

  /**
  Release only this browser's native subscriptions.
  */
  private readonly disconnect = () => {
    this.unsubscribeReports?.();
    this.unsubscribeReports = undefined;
    this.bridge.snapshots.removeEventListener("snapshot", this.changed);
    this.text = undefined;
    log().info({ connectionId: this.connectionId }, "sse.closed");
  };

  /** Subscribe before asynchronous connection hydration can publish its first change.
  @param stream - Request-scoped text transport.
  @returns Exact producer teardown.
  */
  private readonly connect = (stream: TextStream) => {
    this.text = stream;
    this.bridge.snapshots.addEventListener("snapshot", this.changed);
    const subscribed = t(this.subscribe.bind(this));

    if (!subscribed.ok) {
      valueAfterCleanup(subscribed, t(this.disconnect));
    }

    void this.connectAndPublish();

    return this.disconnect;
  };

  /** Retain the request and canonical bridge without opening another native connection.
  @param request - Browser request supplying cancellation and diagnostics.
  @param bridge - Canonical parent owner.
  */
  constructor(
    private request: Request,
    private bridge: Bridge
  ) {}

  /**
  Subscribe to durable reports and publish the initial canonical projection.
  */
  private subscribe() {
    this.unsubscribeReports = delegations().subscribe(this.changed);
    this.changed();
  }

  /**
  Observe hydration failure and publish the resulting connection state.
  */
  private async connectAndPublish() {
    const connected = await t(this.bridge.ensureConnected.bind(this.bridge));

    if (!connected.ok) {
      log().error({ error: connected.error, connectionId: this.connectionId }, "sse.connect_failed");
    }

    if (!this.text) {
      return;
    }

    const published = t(this.changed);

    if (published.ok) {
      return;
    }

    log().error({ error: published.error, connectionId: this.connectionId }, "sse.publish_failed");
    this.text.close();
  }

  /** Open the request-owned snapshot stream with the existing named heartbeat contract.
  @returns Private streaming HTTP response.
  */
  response() {
    log().info({ connectionId: this.connectionId, userAgent: this.request.headers.get("user-agent") }, "sse.open");
    const stream = new TextStream(this.request.signal, this.connect, HEARTBEAT_MS, "event: heartbeat\ndata: {}\n\n");

    return new Response(new ReadableStream(stream), {
      headers: {
        ...noStore,
        "Cache-Control": "no-store, no-transform",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  }
}
