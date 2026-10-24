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
  return guard(request)
    .then(pushPublicKey)
    .then((publicKey) => Response.json({ publicKey }, { headers: noStore }))
    .catch((error: unknown) => errorResponse(error, HTTP_FORBIDDEN));
}

/**
Stores a validated receiving-device subscription after mutation authorization.
@param request - Unread JSON subscription request.
@returns Non-cacheable subscription receipt or existing validation failure.
*/
export async function POST(request: Request) {
  const outcome = await attempt(guard, request, true);

  return outcome.ok
    ? readBody(request)
        .then(saveSubscription)
        .then(() => Response.json({ subscribed: true }, { headers: noStore }))
        .catch(errorResponse)
    : errorResponse(outcome.error, HTTP_FORBIDDEN);
}
