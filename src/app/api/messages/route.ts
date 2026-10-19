import { HTTP_FORBIDDEN, MAX_MESSAGE_LENGTH } from "@/lib/constants";
import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { bridge } from "@/server/bridge";
import { z } from "zod";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await guard(request, true);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  try {
    const input = z
      .object({ id: z.string().uuid(), text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) })
      .strict()
      .parse(await readBody(request));

    return Response.json(await bridge.send(input.id, input.text), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
