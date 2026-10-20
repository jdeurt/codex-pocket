import { errorResponse, guard } from "@/server/http";
import { HTTP_FORBIDDEN } from "@/lib/constants";
import { SnapshotStream } from "@/server/snapshot-stream";
import { bridge } from "@/server/bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Subscribe an authorized browser to the existing parent's visible snapshots.
@param request - Browser request whose origin and cancellation are enforced.
@returns Private parent event stream, or the existing authorization error response.
*/
export async function GET(request: Request) {
  try {
    await guard(request);
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }

  return new SnapshotStream(request, bridge).response();
}
