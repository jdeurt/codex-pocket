/* eslint-disable jdeurt/const-on-top, jsdoc/require-param, jsdoc/require-returns, unicorn/try-complexity -- Stream setup and cleanup are sequential for one native owner. */
import { errorResponse, guard, noStore } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { requestBridge } from "@/server/named-pockets";

// Eight seconds of PCM16 mono at 24 kHz, including base64 and framing overhead.
const MAX_AUDIO_SECONDS = 8;
const AUDIO_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_SAMPLE = 2;
const BASE64_CHARACTERS = 4;
const BASE64_BYTES = 3;
const EVENT_FRAMING_BYTES = 32_000;
const MAX_PENDING_BYTES =
  (MAX_AUDIO_SECONDS * AUDIO_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * BASE64_CHARACTERS) / BASE64_BYTES +
  EVENT_FRAMING_BYTES;

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

    const stream = new ReadableStream<Uint8Array>(
      {
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

            const encoded = encoder.encode(JSON.stringify(message) + "\n");

            if (controller.desiredSize !== null && encoded.byteLength > controller.desiredSize) {
              controller.enqueue(
                encoder.encode(JSON.stringify({ type: "error", error: "Audio event stream fell behind." }) + "\n")
              );
              close();
              void bridge.realtime.stop(token).catch(() => {
                // A missing native close remains explicit in realtime status; this stream is already closed.
              });

              return;
            }

            controller.enqueue(encoded);
          };
          onAbort = () => {
            close();
            void bridge.realtime.stop(token).catch(() => {
              // A missing native close remains explicit in realtime status; this stream is already closed.
            });
          };
          bridge.realtime.addEventListener("message", onMessage);
          request.signal.addEventListener("abort", onAbort, { once: true });
          const status = JSON.stringify(bridge.realtime.status()) + "\n";

          controller.enqueue(encoder.encode(status));
        },
        cancel() {
          request.signal.dispatchEvent(new Event("abort"));
        },
      },
      { highWaterMark: MAX_PENDING_BYTES, size: (chunk) => chunk.byteLength }
    );

    return new Response(stream, {
      headers: { ...noStore, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform" },
    });
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }
}
