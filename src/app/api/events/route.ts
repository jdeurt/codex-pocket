import { errorResponse, guard, noStore } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { type Snapshot } from "@/lib/protocol";
import { bridge } from "@/server/bridge";
import { log } from "@/server/logging";
import { visibleSnapshot } from "@/server/visible-snapshot";

const HEARTBEAT_MS = 15_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await guard(request);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  let cleanup: ((shouldCloseStream: boolean) => void) | undefined;

  const connectionId = crypto.randomUUID();

  log().info({ connectionId, userAgent: request.headers.get("user-agent") }, "sse.open");
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const abort = () => cleanup?.(true);

      let isClosed = false;

      const send = (state: Snapshot) => {
        if (isClosed) {
          return;
        }

        const visible = visibleSnapshot(state);

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(visible)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!isClosed) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }
      }, HEARTBEAT_MS);
      const dispose = (shouldCloseStream: boolean) => {
        if (isClosed) {
          return;
        }

        isClosed = true;
        log().info({ connectionId }, "sse.closed");
        clearInterval(heartbeat);
        bridge.off("snapshot", send);
        request.signal.removeEventListener("abort", abort);

        if (shouldCloseStream) {
          controller.close();
        }
      };

      cleanup = dispose;
      bridge.on("snapshot", send);
      request.signal.addEventListener("abort", abort, { once: true });
      send(bridge.snapshot);
      void bridge
        .ensureConnected()
        .then(() => {
          send(bridge.snapshot);
        })
        .catch(() => {
          send(bridge.snapshot);
        });
    },
    cancel() {
      cleanup?.(false);
    },
  });

  return new Response(stream, {
    headers: {
      ...noStore,
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
