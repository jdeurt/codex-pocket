import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { log } from "@/server/logging";
import { z } from "zod";
import { t as attempt } from "try";

const MAX_EVENTS = 20;
const MAX_EVENT_NAME = 100;
const eventSchema = z.object({
  id: z.uuid(),
  time: z.iso.datetime(),
  level: z.enum(["info", "error"]),
  event: z.string().max(MAX_EVENT_NAME),
  details: z.record(z.string(), z.unknown()),
});
const schema = z.object({ events: z.array(eventSchema).max(MAX_EVENTS) });
export const runtime = "nodejs";

/**
Validates one bounded browser log batch before recording native structured events.
@param request - Authorized mutation request with an unread JSON body.
@returns Non-cacheable receipt containing the number of accepted events.
*/
async function recordClientEvents(request: Request) {
  const { events } = schema.parse(await readBody(request));

  for (const entry of events) {
    log()[entry.level]({ client: entry, userAgent: request.headers.get("user-agent") }, entry.event);
  }

  return Response.json({ received: events.length }, { headers: noStore });
}

/**
Accepts browser diagnostics only after same-origin mutation authorization.
@param request - Incoming native JSON request.
@returns Accepted batch receipt or distinct authorization/validation error response.
*/
export async function POST(request: Request) {
  const outcome = await attempt(async () => {
    await guard(request, true);
  });

  if (!outcome.ok) {
    const error = outcome.error;

    return errorResponse(error, HTTP_FORBIDDEN);
  }

  return (async () => recordClientEvents(request))().catch((error: unknown) => {
    return errorResponse(error);
  });
}
