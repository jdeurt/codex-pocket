import { errorResponse, guard } from "@/server/http";
import { spinners } from "@/server/spinners";

const NOT_FOUND = 404;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await guard(request);

    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new Error("Spinner is available only inside Pocket.");
    }

    const { id } = await context.params;
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
  } catch {
    return errorResponse(new Error("Spinner unavailable."), NOT_FOUND);
  }
}
