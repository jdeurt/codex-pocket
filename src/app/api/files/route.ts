import { errorResponse, guard, noStore } from "@/server/http";
import { readFile } from "node:fs/promises";
import { requestConfig } from "@/server/pocket-config";
import { viewerFile } from "@/server/file-viewer";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Encode validated metadata or a native browser response with active file content sandboxed.
@param url - Authorized file route and metadata selector.
@returns Private file response without granting executable documents Pocket's origin authority.
*/
async function fileResponse(url: URL) {
  const file = await viewerFile(z.string().min(1).parse(url.searchParams.get("path")));

  if (url.searchParams.get("metadata") === "1") {
    return Response.json(file, { headers: noStore });
  }

  return new Response(new Uint8Array(await readFile(file.filename)), {
    headers: {
      ...noStore,
      "Content-Type": file.type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "sandbox allow-downloads; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": `${file.type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    },
  });
}

/**
Reject cross-site embedding before reading any local file metadata or bytes.
@param request - Origin-authorized file request.
*/
function authorizeSite(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Files are available only inside Pocket.");
  }
}

/**
Serve local metadata or native file bytes only after the existing host/origin boundary.
@param request - Same-site viewer request identifying a regular local file.
@returns Shared Markdown source, sandboxed native content, or an attachment download.
*/
export async function GET(request: Request) {
  return (async () => {
    await guard(request);

    authorizeSite(request);
    await requestConfig(request);

    return await fileResponse(new URL(request.url));
  })().catch((error: unknown) => {
    return errorResponse(error);
  });
}
