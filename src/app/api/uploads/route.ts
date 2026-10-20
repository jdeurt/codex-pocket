import { downloadUpload, getUpload, saveUpload, uploadPath } from "@/server/uploads";
import { errorResponse, guard, noStore } from "@/server/http";
import { readConfig } from "@/server/config";
import { renderImage } from "@/server/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parent(request: Request, isMutation = false) {
  await guard(request, isMutation, "application/octet-stream");

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Files are available only inside Pocket.");
  }

  const config = await readConfig();

  if (!config) {
    throw new Error("Configure a thread on your computer first.");
  }

  return config;
}

export async function PUT(request: Request) {
  try {
    const config = await parent(request, true);
    const file = await saveUpload(config.threadId, new URL(request.url).searchParams.get("id") ?? "", request);

    return Response.json({ file }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const config = await parent(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    const headers = {
      ...noStore,
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };

    if (url.searchParams.get("preview") === "1") {
      const file = await getUpload(config.threadId, id);

      if (file.kind !== "image") {
        throw new Error("This file has no image preview.");
      }

      const { bytes } = await renderImage(
        uploadPath(config.threadId, file, true),
        config.cwd,
        url.searchParams.get("thumbnail") === "1"
      );

      return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "image/webp" } });
    }

    const { file, bytes } = await downloadUpload(config.threadId, id);

    return new Response(new Uint8Array(bytes), {
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(file.size),
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
