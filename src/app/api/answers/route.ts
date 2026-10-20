import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { requestBridge } from "@/server/named-pockets";
import { z } from "zod";

export const runtime = "nodejs";

/**
Submits a validated phone answer only after same-origin mutation authorization.
@param request - Unread JSON request containing the pending native request identity and answer.
@returns Existing acknowledgment or distinct authorization/answer-validation failure.
*/
export async function POST(request: Request) {
  try {
    await guard(request, true);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  try {
    const bridge = await requestBridge(request);
    const input = z
      .object({ id: z.union([z.string(), z.number()]), result: z.unknown() })
      .strict()
      .parse(await readBody(request));

    await bridge.answer(input.id, input.result);

    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
