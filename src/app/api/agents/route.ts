import { HTTP_FORBIDDEN, HTTP_NOT_FOUND } from "@/lib/constants";
import { endpoint, errorResponse, guard, noStore } from "@/server/http";
import { type Config } from "@/server/config";
import { agentBrowser } from "@/server/agents";
import { renderImage } from "@/server/images";
import { requestConfig } from "@/server/pocket-config";
import { t as attempt } from "try";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Encodes a verified native image without exposing its original local path.
@param source - Native image source resolved by the scoped browser.
@param cwd - Native working directory used to resolve relative image paths.
@param isThumbnail - Whether the client requested the bounded thumbnail rendition.
@returns Private WebP response.
*/
async function renderedAgentImage(source: string, cwd: string, isThumbnail: boolean) {
  const rendered = await renderImage(source, cwd, isThumbnail);

  return new Response(new Uint8Array(rendered.bytes), {
    headers: { ...noStore, "Content-Type": "image/webp", "Cross-Origin-Resource-Policy": "same-origin" },
  });
}

/**
Renders a scoped native child image after the request's origin and parent were authorized.
@param config - Server-owned parent identity and native working directory.
@param url - Authorized request's image selection.
@param id - Scoped child identity.
@param item - Saved native item containing the selected image.
@returns Original redirect or rendered private image response.
*/
async function agentImage(config: Config, url: URL, id: string, item: string) {
  const image = await agentBrowser(config.threadId).image(
    config.threadId,
    id,
    item,
    Number(url.searchParams.get("index") ?? 0),
    url.searchParams.get("source") ?? undefined
  );

  return /^https?:\/\//i.test(image.source)
    ? Response.redirect(image.source)
    : renderedAgentImage(image.source, image.cwd, url.searchParams.get("thumbnail") === "1");
}

/**
Selects catalog, transcript or image reads using the configured parent, never URL-provided ancestry.
@param request - Origin-authorized read-only request.
@param config - Server configuration establishing the native parent identity.
@returns Scoped read response.
*/
async function configuredAgents(request: Request, config: Config) {
  const url = new URL(request.url);
  const id = url.searchParams.get("agent");
  const item = url.searchParams.get("item");

  if (id && item) {
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new Error("Image access denied.");
    }

    return agentImage(config, url, id, item);
  }

  return Response.json(
    id
      ? await agentBrowser(config.threadId).transcript(config.threadId, id)
      : await agentBrowser(config.threadId).catalog(config.threadId, url.searchParams.get("view") === "list"),
    { headers: noStore }
  );
}

/**
Requires a configured parent before any native agent discovery or history access.
@param request - Origin-authorized GET request.
@returns Scoped response or the existing unconfigured-parent response.
*/
async function agentResponse(request: Request) {
  const config = await requestConfig(request);

  return configuredAgents(request, config);
}

/**
Serves GET-only native agent history with distinct access-denied and unavailable responses.
@param request - Incoming native request, authorized before reading configured parent state.
@returns Non-cacheable catalog, transcript, image or sanitized error response.
*/
export const GET = endpoint(
  async (request: Request) => {
    const outcome = await attempt(guard, request);

    return outcome.ok
      ? agentResponse(request)
      : Response.json({ error: "Agent history access denied." }, { status: HTTP_FORBIDDEN, headers: noStore });
  },
  () => {
    return errorResponse(new Error("Agent history is unavailable in this parent chat."), HTTP_NOT_FOUND);
  }
);
