import { errorResponse, guard, noStore } from "@/server/http";
import { readFile } from "node:fs/promises";
import { viewerFile } from "@/server/file-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Serve local metadata or native file bytes only after the existing host/origin boundary.
@param request - Same-site viewer request identifying a regular local file.
@returns Shared Markdown source, sandboxed native content, or an attachment download.
*/
export async function GET(request: Request) {
  try {
    await guard(request);

    if (request.headers.get("sec-fetch-site") === "cross-site") {
      throw new Error("Files are available only inside Pocket.");
    }

    return await fileResponse(new URL(request.url));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
Encode validated metadata or a native browser response with active file content sandboxed.
@param url - Authorized file route and metadata selector.
@returns Private file response without granting executable documents Pocket's origin authority.
*/
async function fileResponse(url: URL) {
  const source = url.searchParams.get("path");

  if (!source) {
    throw new Error("Choose a local file.");
  }

  const file = await viewerFile(source);

  if (url.searchParams.get("metadata") === "1") {
    return Response.json(file, { headers: noStore });
  }

  return new Response(new Uint8Array(await readFile(file.filename)), {
    headers: {
      ...noStore,
      "Content-Type": file.type,
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": `${file.type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    },
  });
}
