import { errorResponse, guard } from "@/server/http";
import { spinners } from "@/server/spinners";

const NOT_FOUND = 404;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Authorizes native spinner bytes before resolving a requested asset identity.
@param request - Incoming request with unread native asset state.
*/
async function authorizeSpinner(request: Request) {
  await guard(request);

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Spinner is available only inside Pocket.");
  }
}

/**
Reads the selected native asset and preserves conditional ETag delivery.
@param request - Authorized request supplying the conditional cache header.
@param params - Next's asynchronous asset identity, resolved only after authorization.
@returns Original spinner bytes or unchanged-asset response.
*/
async function spinnerAsset(request: Request, params: Promise<{ id: string }>) {
  const { id } = await params;
  const { bytes, mime, etag } = await spinners().asset(id);
  const headers = {
    "Content-Type": mime,
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ETag: etag,
  };

  return request.headers.get("if-none-match") === etag
    ? new Response(null, { status: 304, headers })
    : new Response(new Uint8Array(bytes), { headers });
}

/**
Serves private spinner bytes with the existing sanitized not-found response.
@param request - Incoming native asset request.
@param context - Next's asynchronous route parameters.
@returns Conditional asset response or sanitized native failure.
*/
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return (async () => {
    await authorizeSpinner(request);

    return await spinnerAsset(request, context.params);
  })().catch(() => {
    return errorResponse(new Error("Spinner unavailable."), NOT_FOUND);
  });
}
