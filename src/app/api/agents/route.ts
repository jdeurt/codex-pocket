import { HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_SERVICE_UNAVAILABLE } from "@/lib/constants";
import { errorResponse, guard, noStore } from "@/server/http";
import { agentBrowser } from "@/server/agents";
import { readConfig } from "@/server/config";
import { renderImage } from "@/server/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deliberately GET-only. Parent identity comes from server configuration, never URL input.
async function agentResponse(request: Request) {
  const config = await readConfig();

  if (!config) {
    return Response.json(
      { error: "Parent chat is not configured." },
      { status: HTTP_SERVICE_UNAVAILABLE, headers: noStore }
    );
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("agent");
  const item = url.searchParams.get("item");

  if (id && item) {
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new Error("Image access denied.");
    }

    const image = await agentBrowser().image(
      config.threadId,
      id,
      item,
      Number(url.searchParams.get("index") ?? 0),
      url.searchParams.get("source") ?? undefined
    );

    if (/^https?:\/\//i.test(image.source)) {
      return Response.redirect(image.source);
    }

    const rendered = await renderImage(image.source, image.cwd, url.searchParams.get("thumbnail") === "1");

    return new Response(new Uint8Array(rendered.bytes), {
      headers: { ...noStore, "Content-Type": "image/webp", "Cross-Origin-Resource-Policy": "same-origin" },
    });
  }

  return Response.json(
    id
      ? await agentBrowser().transcript(config.threadId, id)
      : await agentBrowser().catalog(config.threadId, url.searchParams.get("view") === "list"),
    { headers: noStore }
  );
}

export async function GET(request: Request) {
  try {
    await guard(request);
  } catch {
    return Response.json({ error: "Agent history access denied." }, { status: HTTP_FORBIDDEN, headers: noStore });
  }

  try {
    return await agentResponse(request);
  } catch {
    return errorResponse(new Error("Agent history is unavailable in this parent chat."), HTTP_NOT_FOUND);
  }
}
