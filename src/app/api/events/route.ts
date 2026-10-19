import { errorResponse, guard, noStore } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import type { Snapshot } from "@/lib/protocol";
import { bridge } from "@/server/bridge";
import { log } from "@/server/logging";

const HEARTBEAT_MS = 15_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await guard(request);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  let cleanup: ((closeStream: boolean) => void) | undefined;
  const connectionId = crypto.randomUUID();
  log().info({ connectionId, userAgent: request.headers.get("user-agent") }, "sse.open");
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const abort = () => cleanup?.(true);
      let closed = false;
      const send = (state: Snapshot) => {
        if (closed) {
          return;
        }

        // Tool activity is represented only by Thinking. Do not transmit tool logs.
        const visible = {
          ...state,
          notices: [],
          turns: state.turns.map((turn) => ({
            ...turn,
            items: turn.items.filter((item) => ["userMessage", "agentMessage"].includes(item.type)),
          })),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(visible)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }
      }, HEARTBEAT_MS);
      const dispose = (closeStream: boolean) => {
        if (closed) {
          return;
        }

        closed = true;
        log().info({ connectionId }, "sse.closed");
        clearInterval(heartbeat);
        bridge.off("snapshot", send);
        request.signal.removeEventListener("abort", abort);

        if (closeStream) {
          controller.close();
        }
      };
      cleanup = dispose;
      bridge.on("snapshot", send);
      request.signal.addEventListener("abort", abort, { once: true });
      send(bridge.snapshot);
      void bridge
        .ensureConnected()
        .then(() => send(bridge.snapshot))
        .catch(() => send(bridge.snapshot));
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
