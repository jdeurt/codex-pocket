import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dataSchema } from "../../src/lib/protocol";
import { t } from "try";

const HTTP_ERROR = 500;

/** Report synthetic-provider failures at the HTTP boundary.
@param failures - Test-visible unexpected failures.
@param handle - Native request handler.
@param request - Native request.
@param response - Native response.
*/
async function respond(
  failures: string[],
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  request: IncomingMessage,
  response: ServerResponse
) {
  const result = await t(handle, request, response);

  if (result.ok) {
    return;
  }

  failures.push(String(result.error));
  response.writeHead(HTTP_ERROR).end();
}

/** Start an owned HTTP task from the native synchronous listener.
@param failures - Test-visible unexpected failures.
@param handle - Native request handler.
@param request - Native request.
@param response - Native response.
*/
function requested(
  failures: string[],
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  request: IncomingMessage,
  response: ServerResponse
) {
  void respond(failures, handle, request, response);
}

/** Own the error boundary shared by synthetic Live HTTP providers.
@param server - Fixture server whose WebSocket ownership remains with its caller.
@param failures - Test-visible unexpected failures.
@param handle - Request routing and response logic.
*/
export function serveRealtimeHttp(
  server: Server,
  failures: string[],
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
) {
  server.on("request", requested.bind(undefined, failures, handle));
}

/** Parse the same JSON session contract in API and browser realtime fixtures.
@param request - Unread provider request.
@returns SDP and validated provider session settings.
*/
export async function readRealtimeOffer(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const body = dataSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  const transport = dataSchema.parse(body.transport);

  if (transport.type !== "webrtc" || typeof transport.sdp !== "string") {
    throw new TypeError("Live session is missing its WebRTC offer.");
  }

  return { sdp: transport.sdp, session: dataSchema.parse(body.session) };
}
