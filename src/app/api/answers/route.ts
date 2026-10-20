import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
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
      .object({ id: z.union([z.string(), z.number()]), result: z.unknown() })
      .strict()
      .parse(await readBody(request));

    await bridge.answer(input.id, input.result);

    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
