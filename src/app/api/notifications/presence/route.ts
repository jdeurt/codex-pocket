import { endpoint, errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { notificationPresence } from "@/server/notification-presence";
import { z } from "zod";
import { t as attempt } from "try";

import { presenceStream } from "@/server/presence-stream";

const deviceSchema = z.string().regex(/^[\da-f]{64}$/);
const acknowledgementSchema = z.object({ deviceId: deviceSchema, challengeId: z.uuid() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  return new Response(presenceStream(request.signal, notificationPresence, device.data), {
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
  const outcome = await attempt(guard, request);

  return outcome.ok ? presenceResponse(request) : errorResponse(outcome.error, HTTP_FORBIDDEN);
}

/**
Acknowledges a device challenge after same-origin mutation authorization.
@param request - Native JSON request carrying the receiving device and challenge identities.
@returns Whether the still-pending challenge belonged to that device.
*/
export const POST = endpoint(async (request: Request) => {
  const authorized = await attempt(guard, request, true);

  if (!authorized.ok) {
    return errorResponse(authorized.error, HTTP_FORBIDDEN);
  }

  const body = await readBody(request);
  const { deviceId, challengeId } = acknowledgementSchema.parse(body);

  return Response.json({ acknowledged: notificationPresence.acknowledge(deviceId, challengeId) }, { headers: noStore });
});
