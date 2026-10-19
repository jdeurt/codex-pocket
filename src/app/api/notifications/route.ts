import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { pushPublicKey, saveSubscription } from "@/server/push";
import { HTTP_FORBIDDEN } from "@/lib/constants";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await guard(request);

    return Response.json({ publicKey: await pushPublicKey() }, { headers: noStore });
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }
}

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
