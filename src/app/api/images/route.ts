import { errorResponse, guard } from "@/server/http";
import { bridge } from "@/server/bridge";
import { itemImageSources } from "@/lib/images";
import { readConfig } from "@/server/config";
import { renderImage } from "@/server/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function imageResponse(request: Request) {
  await guard(request);

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Images are available only inside Pocket.");
  }

  const url = new URL(request.url);
  const itemId = url.searchParams.get("item");
  const item = itemId
    ? bridge.snapshot.turns.flatMap((turn) => turn.items).find((entry) => entry.id === itemId)
    : undefined;
  const index = Number(url.searchParams.get("index") ?? 0);
  const source = item ? itemImageSources(item)[index] : itemId ? undefined : url.searchParams.get("path");

  if (!source || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("Image is unavailable in this chat.");
  }

  const config = await readConfig();
  const { bytes, etag } = await renderImage(
    source,
    config?.cwd ?? process.cwd(),
    url.searchParams.get("thumbnail") === "1"
  );
  const headers = {
    "Content-Type": "image/webp",
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: etag,
  };

  return request.headers.get("if-none-match") === etag
    ? new Response(null, { status: 304, headers })
    : new Response(new Uint8Array(bytes), { headers });
}

export async function GET(request: Request) {
  try {
    return await imageResponse(request);
  } catch (error) {
    return errorResponse(error);
  }
}
