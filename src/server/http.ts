import { HTTP_BAD_REQUEST, MAX_BODY_BYTES } from "../lib/constants";
import { log } from "./logging";
import { readConfig } from "./config";

/**
Record request metadata before configuration and authorization work.
@param request - Incoming native HTTP request whose body remains unread.
*/
function logRequest(request: Request) {
  log().debug(
    {
      requestId: request.headers.get("x-pocket-request-id"),
      method: request.method,
      url: request.url,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      userAgent: request.headers.get("user-agent"),
    },
    "http.request"
  );
}

/**
Enforce configured origins and mutation content types after host validation.
@param request - Request whose host has already been authorized.
@param allowed - Exact origins accepted by this process.
@param isMutation - Whether an explicit allowed origin is required.
@param contentType - Expected mutation content-type prefix.
*/
function authorizeOrigin(request: Request, allowed: string[], isMutation: boolean, contentType: string) {
  const origin = request.headers.get("origin");

  if ((isMutation && !origin) || (origin && !allowed.includes(origin))) {
    throw new Error("Origin is not allowed.");
  }

  if (isMutation && !request.headers.get("content-type")?.startsWith(contentType)) {
    throw new Error(`Expected ${contentType}.`);
  }
}

/**
Load configured origins and authorize the host before checking the origin.
@param request - Incoming native HTTP request.
@param isMutation - Whether mutation protections are required.
@param contentType - Expected mutation content-type prefix.
*/
async function authorizeRequest(request: Request, isMutation: boolean, contentType: string) {
  const config = await readConfig();
  const allowed = config?.allowedOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"];
  const host = request.headers.get("host");

  if (!host || allowed.every((origin) => new URL(origin).host !== host)) {
    throw new Error("Host is not allowed. Set CODEX_ALLOWED_ORIGINS on the computer.");
  }

  authorizeOrigin(request, allowed, isMutation, contentType);
}

/**
Log and authorize an HTTP request before its endpoint accesses state.
@param request - Incoming native HTTP request.
@param isMutation - Whether same-origin mutation protection is required.
@param contentType - Expected mutation content-type prefix.
*/
export async function guard(request: Request, isMutation = false, contentType = "application/json") {
  logRequest(request);
  await authorizeRequest(request, isMutation, contentType);
}

/**
Read a bounded body stream and decode its JSON once at the HTTP boundary.
@param reader - Reader acquired from the incoming request body.
@returns Untrusted JSON for validation by the endpoint.
*/
async function readJSONBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];

  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.length;

    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Message is too large.");
    }

    chunks.push(value);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
Require a request body and decode it with the shared byte limit.
@param request - Incoming request whose body has not been consumed.
@returns Untrusted JSON for the endpoint's protocol schema.
*/
export async function readBody(request: Request) {
  const reader = request.body?.getReader();

  if (!reader) {
    throw new Error("Missing message.");
  }

  return readJSONBody(reader);
}

export const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/**
Log an endpoint failure and return its non-cacheable JSON error response.
@param error - Caught endpoint or authorization failure.
@param status - HTTP status selected by the endpoint.
@returns JSON response with the existing user-visible error text.
*/
export function errorResponse(error: unknown, status = HTTP_BAD_REQUEST) {
  log().error({ error, status }, "http.failed");

  return Response.json(
    { error: error instanceof Error ? error.message : "Request failed." },
    { status, headers: noStore }
  );
}
