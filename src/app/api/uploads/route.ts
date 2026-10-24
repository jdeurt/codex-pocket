import { downloadUpload, getUpload, saveUpload, uploadPath } from "@/server/uploads";
import { errorResponse, guard, noStore } from "@/server/http";
import { type Config } from "@/server/config";
import { type FileAttachment } from "@/lib/attachments";
import { renderImage } from "@/server/images";
import { requestConfig } from "@/server/pocket-config";

const fileHeaders = {
  ...noStore,
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
Loads the native parent only after request authorization and same-site checks.
@param request - Authorized request carrying a saved Pocket identity.
@returns Configured parent identity and working directory.
*/
async function requireParent(request: Request) {
  const config = await requestConfig(request);

  return config;
}

/**
Authorizes native attachment access before loading parent configuration.
@param request - Incoming attachment request.
@param isMutation - Whether the original byte upload requires mutation protection.
@returns Configured parent whose attachment namespace may be accessed.
*/
async function parent(request: Request, isMutation = false) {
  await guard(request, isMutation, "application/octet-stream");

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Files are available only inside Pocket.");
  }

  return requireParent(request);
}

/**
Persists original request bytes in the authorized parent's attachment namespace.
@param request - Unconsumed upload request carrying its stable attachment identity.
@returns Non-cacheable canonical saved-file receipt.
*/
async function uploadResponse(request: Request) {
  const config = await parent(request, true);
  const file = await saveUpload(config.threadId, new URL(request.url).searchParams.get("id") ?? "", request);

  return Response.json({ file }, { headers: noStore });
}

/**
Accepts an original attachment upload and converts native failures to the existing JSON error.
@param request - Incoming binary mutation request.
@returns Saved-file receipt or logged failure.
*/
export async function PUT(request: Request) {
  return (async () => uploadResponse(request))().catch((error: unknown) => {
    return errorResponse(error);
  });
}

/**
Renders an image attachment already verified to belong to the configured parent.
@param config - Authorized native parent configuration.
@param url - Parsed preview query.
@param file - Canonical stored image attachment.
@returns WebP preview response.
*/
async function renderedPreview(config: Config, url: URL, file: FileAttachment) {
  const { bytes } = await renderImage(
    uploadPath(config.threadId, file, true),
    config.cwd,
    url.searchParams.get("thumbnail") === "1"
  );

  return new Response(new Uint8Array(bytes), { headers: { ...fileHeaders, "Content-Type": "image/webp" } });
}

/**
Requires an actual image attachment before invoking native image rendering.
@param config - Authorized parent configuration.
@param url - Parsed rendition query.
@param id - Stored attachment identity.
@returns WebP preview response.
*/
async function previewResponse(config: Config, url: URL, id: string) {
  const file = await getUpload(config.threadId, id);

  if (file.kind !== "image") {
    throw new Error("This file has no image preview.");
  }

  return renderedPreview(config, url, file);
}

/**
Downloads original stored bytes without modifying their transport encoding.
@param threadId - Authorized parent attachment namespace.
@param id - Saved attachment identity.
@returns Original binary payload and encoded download name.
*/
async function originalResponse(threadId: string, id: string) {
  const { file, bytes } = await downloadUpload(threadId, id);

  return new Response(new Uint8Array(bytes), {
    headers: {
      ...fileHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`,
    },
  });
}

/**
Selects preview or original delivery after authorizing and loading the parent.
@param request - Incoming native attachment read.
@returns Private attachment response.
*/
async function downloadResponse(request: Request) {
  const config = await parent(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";

  return url.searchParams.get("preview") === "1"
    ? previewResponse(config, url, id)
    : originalResponse(config.threadId, id);
}

/**
Serves a stored attachment while retaining the existing logged error response.
@param request - Incoming original-download or preview request.
@returns Private attachment bytes or JSON failure.
*/
export async function GET(request: Request) {
  return (async () => downloadResponse(request))().catch((error: unknown) => {
    return errorResponse(error);
  });
}
