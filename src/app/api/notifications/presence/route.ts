import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { notificationPresence } from "@/server/notification-presence";
import { z } from "zod";

const HEARTBEAT_MS = 15_000;
const deviceSchema = z.string().regex(/^[\da-f]{64}$/);
const acknowledgementSchema = z.object({ deviceId: deviceSchema, challengeId: z.uuid() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await guard(request);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  const device = deviceSchema.safeParse(new URL(request.url).searchParams.get("device"));

  if (!device.success) {
    return errorResponse(new Error("Invalid notification device."));
  }

  let cleanup: ((close: boolean) => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
      };
      const disconnect = notificationPresence.connect(device.data, (challengeId) => {
        send(`event: probe\ndata: ${JSON.stringify({ challengeId })}\n\n`);
      });
      const heartbeat = setInterval(() => {
        send(": keepalive\n\n");
      }, HEARTBEAT_MS);
      const abort = () => cleanup?.(true);

      let closed = false;

      cleanup = (close) => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(heartbeat);
        disconnect();
        request.signal.removeEventListener("abort", abort);

        if (close) {
          controller.close();
        }
      };
      request.signal.addEventListener("abort", abort, { once: true });

      if (request.signal.aborted) {
        abort();
      } else {
        send(": connected\n\n");
      }
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

export async function POST(request: Request) {
  try {
    await guard(request, true);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  try {
    const { deviceId, challengeId } = acknowledgementSchema.parse(await readBody(request));

    return Response.json(
      { acknowledged: notificationPresence.acknowledge(deviceId, challengeId) },
      { headers: noStore }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
