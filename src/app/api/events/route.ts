import { errorResponse, guard } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { SnapshotStream } from "@/server/snapshot-stream";
import { bridge } from "@/server/bridge";
import { requestBridge } from "@/server/named-pockets";
import { t as attempt } from "try";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Subscribe before native hydration so transient failures remain visible and reconnectable.
@param request - Authorized request with per-tab Pocket selection.
@returns Private parent snapshot stream.
*/
async function stream(request: Request) {
  const parent = process.env.CODEX_THREAD_ID ? await requestBridge(request, true) : bridge;

  return new SnapshotStream(request, parent).response();
}

/**
Subscribe an authorized browser to the existing parent's visible snapshots.
@param request - Browser request whose origin and cancellation are enforced.
@returns Private parent event stream, or the existing authorization error response.
*/
export async function GET(request: Request) {
  const outcome = await attempt(guard, request);

  if (!outcome.ok) {
    return errorResponse(outcome.error, HTTP_FORBIDDEN);
  }

  return stream(request).catch((error: unknown) => {
    return errorResponse(error);
  });
}
