import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { bridge } from "@/server/bridge";
import { sessionSettingsSchema } from "@/server/session-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Inspect this Pocket's connected session without exposing arbitrary native RPC.
@param request - Host and origin checked request.
@returns Effective parent settings and native usage availability.
*/
export async function GET(request: Request) {
  try {
    await guard(request);
    await bridge.ensureConnected();

    return Response.json(bridge.sessionInfo(), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
Change only this Pocket's next-turn model or effort over its existing connection.
@param request - Same-origin mutation with a strict model/effort body.
@returns Native readback and persistence timing, or an explicit failure without retry.
*/
export async function POST(request: Request) {
  try {
    await guard(request, true);

    return Response.json(await bridge.updateSession(sessionSettingsSchema.parse(await readBody(request))), {
      headers: noStore,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
