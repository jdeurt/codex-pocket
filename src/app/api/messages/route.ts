import { HTTP_FORBIDDEN, MAX_MESSAGE_LENGTH } from "@/lib/constants";
import { endpoint, errorResponse, guard, noStore, readBody } from "@/server/http";
import { MAX_ATTACHMENTS } from "@/lib/attachments";
import { requestBridge } from "@/server/named-pockets";
import { z } from "zod";
import { t as attempt } from "try";

export const runtime = "nodejs";

/** Validate meaningful message content independently of request handling.
@param value - Normalized text and attachment identities.
@returns Whether the submission contains text or a file.
*/
function hasSubmissionContent(value: { text: string; attachments: string[] }) {
  return value.text.length > 0 || value.attachments.length > 0;
}

const messageInput = z
  .object({
    id: z.uuid(),
    text: z.string().trim().max(MAX_MESSAGE_LENGTH),
    attachments: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
  })
  .strict()
  .refine(hasSubmissionContent, "Write a message or attach a file.");

/**
Validates a phone message and attachment identities before submitting it to the native bridge.
@param request - Unread same-origin JSON mutation request.
@returns Canonical send receipt or existing authorization/validation failure.
*/
export const POST = endpoint(async (request: Request) => {
  const outcome = await attempt(guard, request, true);

  if (!outcome.ok) {
    return errorResponse(outcome.error, HTTP_FORBIDDEN);
  }

  const bridge = await requestBridge(request);
  const input = messageInput.parse(await readBody(request));

  return Response.json(await bridge.send(input.id, input.text, input.attachments), {
    headers: noStore,
  });
});
