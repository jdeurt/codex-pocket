import { errorResponse, guard, noStore } from "@/server/http";
import { spinners } from "@/server/spinners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Authorizes access before reading the current native spinner preference.
@param request - Incoming same-site preference read.
@returns Non-cacheable current selection.
*/
async function spinnerStatus(request: Request) {
  await guard(request);

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Spinner is available only inside Pocket.");
  }

  return Response.json({ current: spinners().status().current }, { headers: noStore });
}

/**
Serves the current spinner preference without exposing native storage failures.
@param request - Incoming preference read.
@returns Current selection or the existing sanitized failure response.
*/
export async function GET(request: Request) {
  try {
    return await spinnerStatus(request);
  } catch {
    return errorResponse(new Error("Spinner preference unavailable."));
  }
}
