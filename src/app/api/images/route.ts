import { errorResponse, guard } from "@/server/http";
import { itemImageSources } from "@/lib/images";
import { renderImage } from "@/server/images";
import { requestBridge } from "@/server/named-pockets";
import { requestConfig } from "@/server/pocket-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Selects only an image belonging to the requested parent item, with the existing path fallback when no item is selected.
@param request - Authorized parent selection.
@param url - Parsed authorized image request.
@param index - Requested image index, validated before rendering.
@returns Selected native source, or no source when the item/image is unavailable.
*/
async function parentImageSource(request: Request, url: URL, index: number) {
  const itemId = url.searchParams.get("item");
  const bridge = itemId ? await requestBridge(request) : undefined;
  const item = bridge?.snapshot.turns.flatMap((turn) => turn.items).find((entry) => entry.id === itemId);

  if (itemId) {
    return item ? itemImageSources(item)[index] : undefined;
  }

  return url.searchParams.get("path");
}

/**
Renders an authorized parent image and retains conditional cache responses.
@param request - Native request supplying the conditional ETag header.
@param url - Parsed query containing the requested rendition.
@param source - Source verified against the parent transcript or allowed path input.
@returns Private WebP response or unchanged-image status.
*/
async function renderedImage(request: Request, url: URL, source: string) {
  const config = await requestConfig(request);
  const { bytes, etag } = await renderImage(source, config.cwd, url.searchParams.get("thumbnail") === "1");
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

/**
Resolves and validates a parent image selection after request authorization.
@param request - Authorized same-site native request.
@returns Rendered parent image or conditional cache response.
*/
async function imageResponse(request: Request) {
  const url = new URL(request.url);
  const index = Number(url.searchParams.get("index") ?? 0);
  const source = await parentImageSource(request, url, index);

  if (!source || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("Image is unavailable in this chat.");
  }

  return renderedImage(request, url, source);
}

/**
Authorizes image access before resolving any parent transcript or native file.
@param request - Incoming request with unread parent state.
*/
async function authorizeImage(request: Request) {
  await guard(request);

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Images are available only inside Pocket.");
  }
}

/**
Serves parent images after host, origin and same-site checks.
@param request - Incoming image request whose state has not been accessed.
@returns Private rendition or the existing logged error response.
*/
export async function GET(request: Request) {
  try {
    await authorizeImage(request);

    return await imageResponse(request);
  } catch (error) {
    return errorResponse(error);
  }
}
