import { endpoint, guard, noStore } from "@/server/http";
import { costQuerySchema } from "@/lib/costs";
import { readCostReport } from "@/server/cost-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read host-wide accounting after the same authorization checks as central Settings.
@param request - Browser-selected interval, timezone, feature and model filters.
@returns Content-free daily aggregates with explicit missing-cost coverage.
*/
export const GET = endpoint(async (request: Request) => {
  await guard(request);
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = costQuerySchema.parse(params);

  return Response.json(readCostReport(query), { headers: noStore });
});
