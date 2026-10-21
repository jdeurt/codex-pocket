/* eslint-disable jdeurt/const-on-top, jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity -- Stream setup and cleanup are sequential for one native owner. */
import { errorResponse, guard, noStore } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { requestBridge } from "@/server/named-pockets";

const MAX_PENDING_EVENTS = 10;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Stream private audio and transcript events only to the exact current session token.
*/
export async function GET(request: Request) {
  try {
    await guard(request);
    const bridge = await requestBridge(request);
    const token = request.headers.get("x-pocket-realtime-token") ?? "";

    if (!bridge.realtime.owns(token)) {
      throw new Error("Realtime session is no longer active.");
    }

    const encoder = new TextEncoder();

    let onMessage: (event: Event) => void;
    let onAbort: () => void;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let isClosed = false;

        const close = () => {
          if (isClosed) {
            return;
          }

          isClosed = true;
          bridge.realtime.removeEventListener("message", onMessage);
          request.signal.removeEventListener("abort", onAbort);
          controller.close();
        };

        onMessage = (event) => {
          const message: unknown = event instanceof CustomEvent ? event.detail : null;

          if (!bridge.realtime.owns(token)) {
            if (
              message &&
              typeof message === "object" &&
              "type" in message &&
              (message.type === "error" || message.type === "closed")
            ) {
              controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
            }

            close();

            return;
          }

          if (controller.desiredSize !== null && controller.desiredSize < -MAX_PENDING_EVENTS) {
            close();
            void bridge.realtime.stop(token);

            return;
          }

          controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
        };
        onAbort = () => {
          close();
          void bridge.realtime.stop(token);
        };
        bridge.realtime.addEventListener("message", onMessage);
        request.signal.addEventListener("abort", onAbort, { once: true });
        const status = JSON.stringify(bridge.realtime.status()) + "\n";

        controller.enqueue(encoder.encode(status));
      },
      cancel() {
        request.signal.dispatchEvent(new Event("abort"));
      },
    });

    return new Response(stream, {
      headers: { ...noStore, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform" },
    });
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }
}
