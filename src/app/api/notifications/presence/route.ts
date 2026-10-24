import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { notificationPresence } from "@/server/notification-presence";
import { z } from "zod";
import { t as attempt } from "try";

const HEARTBEAT_MS = 15_000;
const deviceSchema = z.string().regex(/^[\da-f]{64}$/);
const acknowledgementSchema = z.object({ deviceId: deviceSchema, challengeId: z.uuid() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Binds one verified device to an abortable native challenge stream.
@param request - Authorized request owning the stream's abort signal.
@param deviceId - Validated notification device identifier.
@returns Stream emitting challenges and heartbeat frames until disconnect.
*/
function presenceStream(request: Request, deviceId: string) {
  let cleanup: ((shouldClose: boolean) => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
      };
      const disconnect = notificationPresence.connect(deviceId, (challengeId) => {
        send(`event: probe\ndata: ${JSON.stringify({ challengeId })}\n\n`);
      });
      const heartbeat = setInterval(() => {
        send(": keepalive\n\n");
      }, HEARTBEAT_MS);
      const abort = () => cleanup?.(true);

      let isClosed = false;

      cleanup = (close) => {
        if (isClosed) {
          return;
        }

        isClosed = true;
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

  return stream;
}

/**
Validates the requested device before connecting it to foreground notification probes.
@param request - Origin-authorized SSE request.
@returns Private SSE response or invalid-device response.
*/
function presenceResponse(request: Request) {
  const device = deviceSchema.safeParse(new URL(request.url).searchParams.get("device"));

  if (!device.success) {
    return errorResponse(new Error("Invalid notification device."));
  }

  return new Response(presenceStream(request, device.data), {
    headers: {
      ...noStore,
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
Opens a foreground-presence stream only after native host and origin authorization.
@param request - Incoming SSE request with an optional device query.
@returns Private challenge stream or the existing authorization/device error.
*/
export async function GET(request: Request) {
  const outcome = await attempt(async () => {
    await guard(request);
  });

  if (!outcome.ok) {
    const error = outcome.error;

    return errorResponse(error, HTTP_FORBIDDEN);
  }

  return presenceResponse(request);
}

/**
Acknowledges a device challenge after same-origin mutation authorization.
@param request - Native JSON request carrying the receiving device and challenge identities.
@returns Whether the still-pending challenge belonged to that device.
*/
export async function POST(request: Request) {
  const outcome1 = await attempt(async () => {
    await guard(request, true);
  });

  if (!outcome1.ok) {
    const error = outcome1.error;

    return errorResponse(error, HTTP_FORBIDDEN);
  }

  return (async () => {
    const { deviceId, challengeId } = acknowledgementSchema.parse(await readBody(request));

    return Response.json(
      { acknowledged: notificationPresence.acknowledge(deviceId, challengeId) },
      { headers: noStore }
    );
  })().catch((error: unknown) => {
    return errorResponse(error);
  });
}
