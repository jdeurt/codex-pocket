import { errorResponse, guard, noStore } from "@/server/http";
import { BUILD_VERSION } from "@/lib/build-version";
import { HTTP_FORBIDDEN } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
Identify the deployed UI without waiting for a native Codex connection.
@param request - Browser request subject to the normal host and origin protections.
@returns The build identity with caching disabled, or an authorization error.
*/
export async function GET(request: Request) {
  try {
    await guard(request);

    return Response.json({ version: BUILD_VERSION }, { headers: noStore });
  } catch (error) {
    return errorResponse(error, HTTP_FORBIDDEN);
  }
}
