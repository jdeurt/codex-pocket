import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { pushPublicKey, saveSubscription } from "@/server/push";
import { HTTP_FORBIDDEN } from "@/lib/constants";

export const runtime = "nodejs";

/**
Exposes the configured push public key only to an authorized host and origin.
@param request - Incoming native key request.
@returns Non-cacheable key response or authorization failure.
*/
export async function GET(request: Request) {
  try {
    await guard(request);

    return Response.json({ publicKey: await pushPublicKey() }, { headers: noStore });
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }
}

/**
Stores a validated receiving-device subscription after mutation authorization.
@param request - Unread JSON subscription request.
@returns Non-cacheable subscription receipt or existing validation failure.
*/
export async function POST(request: Request) {
  try {
    await guard(request, true);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  try {
    await saveSubscription(await readBody(request));

    return Response.json({ subscribed: true }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
