import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { pushPublicKey, saveSubscription } from "@/server/push";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { t as attempt } from "try";

export const runtime = "nodejs";

/**
Exposes the configured push public key only to an authorized host and origin.
@param request - Incoming native key request.
@returns Non-cacheable key response or authorization failure.
*/
export async function GET(request: Request) {
  return (async () => {
    await guard(request);

    return Response.json({ publicKey: await pushPublicKey() }, { headers: noStore });
  })().catch((error: unknown) => {
    return errorResponse(error, HTTP_FORBIDDEN);
  });
}

/**
Stores a validated receiving-device subscription after mutation authorization.
@param request - Unread JSON subscription request.
@returns Non-cacheable subscription receipt or existing validation failure.
*/
export async function POST(request: Request) {
  const outcome = await attempt(async () => {
    await guard(request, true);
  });

  if (!outcome.ok) {
    const error = outcome.error;

    return errorResponse(error, HTTP_FORBIDDEN);
  }

  return (async () => {
    await saveSubscription(await readBody(request));

    return Response.json({ subscribed: true }, { headers: noStore });
  })().catch((error: unknown) => {
    return errorResponse(error);
  });
}
