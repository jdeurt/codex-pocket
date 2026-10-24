import { createPocket, deletePocket } from "@/server/named-pockets";
import { errorResponse, guard, noStore, readBody } from "@/server/http";
import { pocketHost } from "@/server/pocket-config";
import { pocketNameSchema } from "@/lib/pockets";
import { pocketStore } from "@/server/pocket-store";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), id: z.uuid(), name: pocketNameSchema }).strict(),
  z.object({ action: z.literal("rename"), id: z.string(), name: pocketNameSchema }).strict(),
  z.object({ action: z.literal("delete"), id: z.string() }).strict(),
]);

/** Project saved entries with this tab's explicit selection.
@param request - Authorized browser catalog request.
@returns Private menu catalog.
*/
function catalogResponse(request: Request) {
  return Response.json(
    { pockets: pocketStore().list(), selectedId: new URL(request.url).searchParams.get("pocket") ?? "main" },
    { headers: noStore }
  );
}

/** Dispatch an already authorized mutation through its strict command schema.
@param request - Authorized unread JSON body.
@returns Updated catalog after durable mutation.
*/
async function mutate(request: Request) {
  const input = mutationSchema.parse(await readBody(request));

  switch (input.action) {
    case "create": {
      await createPocket(input.id, input.name);
      break;
    }

    case "rename": {
      pocketStore().rename(input.id, input.name);
      break;
    }

    case "delete": {
      await deletePocket(input.id);
      break;
    }
  }

  return Response.json({ pockets: pocketStore().list() }, { headers: noStore });
}

/** Read saved names and live-derived previews after the existing host/origin guard.
@param request - Authorized browser catalog request.
@returns Durable menu entries and this tab's selected identity.
*/
export async function GET(request: Request) {
  return (async () => {
    await guard(request);
    await pocketHost();

    return catalogResponse(request);
  })().catch((error: unknown) => {
    return errorResponse(error);
  });
}

/** Apply an explicit named-Pocket mutation with durable creation receipts.
@param request - Same-origin JSON mutation.
@returns Updated catalog, or an actionable failure without implicit replay.
*/
export async function POST(request: Request) {
  return (async () => {
    await guard(request, true);
    await pocketHost();

    return await mutate(request);
  })().catch((error: unknown) => {
    return errorResponse(error);
  });
}
