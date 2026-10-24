import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { readPocketSettings, updatePocketSettings } from "@/server/pocket-settings";
import { pocketSettingsMutationSchema } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read global preferences and credential availability after host/origin authorization.
@param request - Browser settings request whose body remains unread.
@returns Non-cacheable public settings without credential values.
*/
export async function GET(request: Request) {
  return guard(request)
    .then(readPocketSettings)
    .then((settings) => Response.json(settings, { headers: noStore }))
    .catch(() => errorResponse(new Error("Could not load Pocket settings.")));
}

/** Validate a partial update and keep credential-bearing failures out of diagnostics.
@param request - Same-origin JSON settings mutation.
@returns Public settings after persistence, or a generic recoverable error.
*/
export async function POST(request: Request) {
  return guard(request, true)
    .then(() => readBody(request))
    .then((body) => updatePocketSettings(pocketSettingsMutationSchema.parse(body)))
    .then((settings) => Response.json(settings, { headers: noStore }))
    .catch(() => errorResponse(new Error("Could not save Pocket settings. Check your input and try again.")));
}
