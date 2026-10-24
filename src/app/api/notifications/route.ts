import { endpoint, errorResponse, guard, noStore, readBody } from "@/server/http";
import { pushPublicKey, saveSubscription } from "@/server/push";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { t as attempt } from "try";

export const runtime = "nodejs";

/**
Exposes the configured push public key only to an authorized host and origin.
@param request - Incoming native key request.
@returns Non-cacheable key response or authorization failure.
*/
export const GET = endpoint(
  async (request: Request) => {
    await guard(request);
    const publicKey = await pushPublicKey();

    return Response.json({ publicKey }, { headers: noStore });
  },
  (error: unknown) => errorResponse(error, HTTP_FORBIDDEN)
);

/**
Stores a validated receiving-device subscription after mutation authorization.
@param request - Unread JSON subscription request.
@returns Non-cacheable subscription receipt or existing validation failure.
*/
export const POST = endpoint(async (request: Request) => {
  const outcome = await attempt(guard, request, true);

  if (!outcome.ok) {
    return errorResponse(outcome.error, HTTP_FORBIDDEN);
  }

  await saveSubscription(await readBody(request));

  return Response.json({ subscribed: true }, { headers: noStore });
});
