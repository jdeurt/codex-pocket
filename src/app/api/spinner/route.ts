import { errorResponse, guard, noStore } from "@/server/http";
import { spinners } from "@/server/spinners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await guard(request);

    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new Error("Spinner is available only inside Pocket.");
    }

    return Response.json({ current: spinners().status().current }, { headers: noStore });
  } catch {
    return errorResponse(new Error("Spinner preference unavailable."));
  }
}
