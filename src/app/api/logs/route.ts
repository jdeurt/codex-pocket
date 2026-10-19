import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { log } from "@/server/logging";
import { z } from "zod";

const MAX_EVENTS = 20;
const MAX_EVENT_NAME = 100;
const schema = z.object({
  events: z
    .array(
      z.object({
        id: z.string().uuid(),
        time: z.string().datetime(),
        level: z.enum(["info", "error"]),
        event: z.string().max(MAX_EVENT_NAME),
        details: z.record(z.string(), z.unknown()),
      })
    )
    .max(MAX_EVENTS),
});
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await guard(request, true);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  try {
    const { events } = schema.parse(await readBody(request));

    for (const entry of events) {
      log()[entry.level]({ client: entry, userAgent: request.headers.get("user-agent") }, entry.event);
    }

    return Response.json({ received: events.length }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
