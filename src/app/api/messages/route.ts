import { HTTP_FORBIDDEN, MAX_MESSAGE_LENGTH } from "@/lib/constants";
import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { MAX_ATTACHMENTS } from "@/lib/attachments";
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
      .object({
        id: z.uuid(),
        text: z.string().trim().max(MAX_MESSAGE_LENGTH),
        attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
      })
      .strict()
      .refine((value) => value.text.length > 0 || value.attachments.length > 0, "Write a message or attach a file.")
      .parse(await readBody(request));

    return Response.json(await bridge.send(input.id, input.text, input.attachments), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
