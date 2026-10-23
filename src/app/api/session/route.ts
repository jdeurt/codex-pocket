import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { requestBridge } from "@/server/named-pockets";
import { sessionSettingsSchema } from "@/server/session-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Validate and dispatch the allowed native settings mutation after HTTP authorization.
@param request - Authorized mutation request.
@returns Effective settings response.
*/
async function updateSettings(request: Request) {
  const bridge = await requestBridge(request);
  const body = await readBody(request);
  const settings = sessionSettingsSchema.parse(body);
  const result = await bridge.session.update(settings);

  return Response.json(result, { headers: noStore });
}

/** Read the selected session only after HTTP authorization.
@param request - Authorized Pocket selection.
@returns Private native session information.
*/
async function sessionInfo(request: Request) {
  const bridge = await requestBridge(request);

  await bridge.ensureConnected();

  const result =
    new URL(request.url).searchParams.get("catalog") === "models"
      ? { models: await bridge.session.models() }
      : bridge.session.info();

  return Response.json(result, { headers: noStore });
}

/**
Inspect this Pocket's connected session without exposing arbitrary native RPC.
@param request - Host and origin checked request.
@returns Effective parent settings and native usage availability.
*/
export async function GET(request: Request) {
  try {
    await guard(request);

    return await sessionInfo(request);
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

    return await updateSettings(request);
  } catch (error) {
    return errorResponse(error);
  }
}
