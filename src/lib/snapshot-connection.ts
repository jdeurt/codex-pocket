import { CONNECTION_LOST_EVENT } from "./build-version";
import { pocketUrl } from "./pockets";
import { reportClient } from "./client-logging";

const RECONNECT_DELAY_MS = 3000;
const STREAM_TIMEOUT_MS = 45_000;

/**
Own explicit retries and heartbeat expiry for one browser snapshot subscription.
*/
export class SnapshotConnection {
  private source?: EventSource;

  private retry?: ReturnType<typeof setTimeout>;

  private watchdog?: ReturnType<typeof setTimeout>;

  private isStopped = false;

  /**
  Restart a visible page's stream after network recovery or restoration from the back-forward cache.
  */
  private readonly wake = () => {
    if (document.visibilityState === "visible") {
      this.connect();
    }
  };

  /**
  Connect and subscribe to browser wake events.
  @param isDisconnected - Accepts a snapshot and returns whether its native connection is disconnected.
  @param lost - Publishes transport loss without erasing the last transcript.
  */
  constructor(
    private isDisconnected: (text: string) => boolean,
    private lost: () => void
  ) {
    this.connect();
    globalThis.addEventListener("online", this.wake);
    globalThis.addEventListener("pageshow", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }

  /**
  Close failed sources explicitly, including CLOSED sources which browsers never retry.
  */
  private reconnect() {
    this.source?.close();
    this.source = undefined;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    this.lost();
    globalThis.dispatchEvent(new Event(CONNECTION_LOST_EVENT));
    this.retry = setTimeout(() => {
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  /**
  Renew liveness on server heartbeats as well as ordinary snapshots.
  */
  private received() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.reconnect();
    }, STREAM_TIMEOUT_MS);
  }

  /**
  Replace the current connection, invalidating callbacks from any earlier source.
  */
  private connect() {
    if (this.isStopped) {
      return;
    }

    reportClient("sse.connecting");
    this.source?.close();
    clearTimeout(this.retry);
    this.listen();
  }

  /**
  Bind callbacks to the exact source instance so delayed events cannot replace newer state.
  */
  private listen() {
    const current = new EventSource(pocketUrl("/api/events"));

    this.source = current;
    this.received();
    current.addEventListener("heartbeat", () => {
      if (this.source === current) {
        this.received();
      }
    });
    current.addEventListener("message", (event: MessageEvent<string>) => {
      if (this.source !== current) {
        return;
      }

      this.received();

      if (this.isDisconnected(event.data)) {
        this.reconnect();
      }
    });
    current.addEventListener("error", () => {
      if (this.source !== current) {
        return;
      }

      reportClient("sse.error", { readyState: current.readyState }, "error");
      this.reconnect();
    });
  }

  /**
  Release the stream, all timers and wake listeners when its last subscriber leaves.
  */
  stop() {
    this.isStopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
    this.source?.close();
    this.source = undefined;
    globalThis.removeEventListener("online", this.wake);
    globalThis.removeEventListener("pageshow", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
  }
}
