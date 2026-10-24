import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { requestBridge } from "@/server/named-pockets";
import { z } from "zod";
import { t as attempt } from "try";

export const runtime = "nodejs";

/**
Submits a validated phone answer only after same-origin mutation authorization.
@param request - Unread JSON request containing the pending native request identity and answer.
@returns Existing acknowledgment or distinct authorization/answer-validation failure.
*/
export async function POST(request: Request) {
  const outcome = await attempt(guard, request, true);

  if (!outcome.ok) {
    return errorResponse(outcome.error, HTTP_FORBIDDEN);
  }

  return requestBridge(request)
    .then(async (bridge) => {
      const input = z
        .object({ id: z.union([z.string(), z.number()]), result: z.unknown() })
        .strict()
        .parse(await readBody(request));

      await bridge.answer(input.id, input.result);

      return Response.json({ ok: true }, { headers: noStore });
    })
    .catch(errorResponse);
}
