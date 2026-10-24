import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dataSchema } from "../../src/lib/protocol";
import { t } from "try";

const HTTP_ERROR = 500;

/** Own the error boundary shared by synthetic realtime HTTP providers.
@param server - Fixture server whose WebSocket ownership remains with its caller.
@param failures - Test-visible unexpected failures.
@param handle - Request routing and response logic.
*/
export function serveRealtimeHttp(
  server: Server,
  failures: string[],
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
) {
  async function respond(request: IncomingMessage, response: ServerResponse) {
    const result = await t(handle, request, response);

    if (result.ok) {
      return;
    }

    failures.push(String(result.error));
    response.writeHead(HTTP_ERROR).end();
  }

  server.on("request", (request, response) => void respond(request, response));
}

/** Parse the same multipart offer contract in API and browser realtime fixtures.
@param request - Unread provider request.
@returns SDP and validated provider session settings.
*/
export async function readRealtimeOffer(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const form = await new Response(Buffer.concat(chunks).toString(), {
    headers: { "Content-Type": request.headers["content-type"] ?? "" },
  }).formData();
  const encoded = form.get("session");

  if (typeof encoded !== "string") {
    throw new TypeError("Realtime offer is missing its session settings.");
  }

  return { sdp: form.get("sdp"), session: dataSchema.parse(JSON.parse(encoded)) };
}
