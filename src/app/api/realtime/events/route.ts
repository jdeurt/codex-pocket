/* eslint-disable jsdoc/require-param, jsdoc/require-returns -- This route exposes only the selected session's status feed. */
import { endpoint, errorResponse, guard, noStore } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { requestBridge } from "@/server/named-pockets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Observe reply text and status. This subscription never transports or owns audio.
*/
async function subscribe(request: Request) {
  await guard(request);
  const bridge = await requestBridge(request);
  const token = request.headers.get("x-pocket-realtime-token") ?? "";

  if (!bridge.realtime.owns(token)) {
    throw new Error(bridge.realtime.status().error ?? "Realtime session is no longer active.");
  }

  const encoder = new TextEncoder();

  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let isClosed = false;

      const close = () => {
        if (isClosed) {
          return;
        }

        isClosed = true;
        cleanup?.();
        controller.close();
      };
      const onMessage = (event: Event) => {
        if (isClosed || !(event instanceof CustomEvent)) {
          return;
        }

        controller.enqueue(encoder.encode(JSON.stringify(event.detail) + "\n"));

        if (!bridge.realtime.owns(token)) {
          close();
        }
      };

      cleanup = () => {
        bridge.realtime.removeEventListener("message", onMessage);
        request.signal.removeEventListener("abort", close);
      };
      bridge.realtime.addEventListener("message", onMessage);
      request.signal.addEventListener("abort", close, { once: true });
      const status = JSON.stringify(bridge.realtime.status()) + "\n";

      controller.enqueue(encoder.encode(status));

      for (const caption of bridge.realtime.liveCaptions()) {
        controller.enqueue(encoder.encode(JSON.stringify(caption) + "\n"));
      }

      if (request.signal.aborted) {
        close();
      }
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: { ...noStore, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform" },
  });
}

/**
Read the selected call's status stream without taking ownership of its media.
*/
export const GET = endpoint(
  async (request: Request) => {
    return subscribe(request);
  },
  (error: unknown) => {
    return errorResponse(error, HTTP_FORBIDDEN);
  }
);
