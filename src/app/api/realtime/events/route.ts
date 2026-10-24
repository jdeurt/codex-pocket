import { endpoint, errorResponse, guard, noStore } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { realtimeStream } from "@/server/realtime-stream";
import { requestBridge } from "@/server/named-pockets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Observe reply text and status. This subscription never transports or owns audio.
@param request - Authorized browser subscription carrying its ownership token.
@returns Private control-event stream response.
*/
async function subscribe(request: Request) {
  await guard(request);
  const bridge = await requestBridge(request);
  const token = request.headers.get("x-pocket-realtime-token") ?? "";

  if (!bridge.realtime.owns(token)) {
    throw new Error(bridge.realtime.status().error ?? "Realtime session is no longer active.");
  }

  const stream = realtimeStream(request.signal, bridge.realtime, token);

  return new Response(stream, {
    headers: { ...noStore, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform" },
  });
}

/**
Return the existing authorization status for an invalid call subscription.
@param error - Original subscription failure.
@returns Public forbidden response.
*/
function forbidden(error: unknown) {
  return errorResponse(error, HTTP_FORBIDDEN);
}

export const GET = endpoint(subscribe, forbidden);
