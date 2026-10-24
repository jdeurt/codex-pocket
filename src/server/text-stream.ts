import { t } from "try";

/**
Request-scoped runtime owner of native text streaming and deterministic teardown.
*/
export class TextStream implements UnderlyingDefaultSource<Uint8Array> {
  private readonly encoder = new TextEncoder();
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private disconnect?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private isClosed = false;

  /** Enqueue an encoded frame only while its native consumer remains active.
  @param text - Fully formatted frame.
  */
  send = (text: string) => {
    if (!this.isClosed) {
      this.controller?.enqueue(this.encoder.encode(text));
    }
  };

  /**
  Release timers, request callbacks and the owned producer subscription.
  */
  cancel = () => {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    clearInterval(this.timer);
    this.signal.removeEventListener("abort", this.close);
    this.disconnect?.();
  };

  /**
  Close a connected native consumer after releasing producer resources.
  */
  close = () => {
    if (this.isClosed) {
      return;
    }

    const cancelled = t(this.cancel);

    if (cancelled.ok) {
      this.controller?.close();
    } else {
      this.controller?.error(cancelled.error);
    }
  };

  /** Start one producer after the native stream allocates its controller.
  @param controller - Native consumer queue.
  */
  start = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    this.controller = controller;

    if (this.signal.aborted) {
      this.close();

      return;
    }

    this.signal.addEventListener("abort", this.close, { once: true });
    const connected = t(this.connect, this);

    if (!connected.ok) {
      const cancelled = t(this.cancel);

      controller.error(
        cancelled.ok
          ? connected.error
          : new AggregateError([connected.error, cancelled.error], "Stream setup and cleanup failed.")
      );

      return;
    }

    this.disconnect = connected.value;

    if (this.isClosed) {
      this.disconnect();

      return;
    }

    if (this.heartbeatMs !== undefined) {
      this.timer = setInterval(this.send, this.heartbeatMs, this.heartbeatFrame);
    }
  };

  /** Retain explicit request and producer dependencies without subscribing.
  @param signal - Owning request's abort signal.
  @param connect - Producer setup returning its teardown.
  @param heartbeatMs - Optional SSE keepalive interval.
  @param heartbeatFrame - Wire frame understood by the consuming watchdog.
  */
  constructor(
    private readonly signal: AbortSignal,
    private readonly connect: (stream: TextStream) => () => void,
    private readonly heartbeatMs?: number,
    private readonly heartbeatFrame = ": keepalive\n\n"
  ) {}
}
