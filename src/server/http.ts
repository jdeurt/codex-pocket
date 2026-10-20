import { HTTP_BAD_REQUEST, MAX_BODY_BYTES } from "../lib/constants";
import { log } from "./logging";
import { readConfig } from "./config";

export async function guard(request: Request, mutation = false, contentType = "application/json") {
  log().debug(
    {
      requestId: request.headers.get("x-pocket-request-id"),
      method: request.method,
      url: request.url,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      userAgent: request.headers.get("user-agent"),
    },
    "http.request"
  );
  const config = await readConfig();
  const allowed = config?.allowedOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"];
  const host = request.headers.get("host");

  if (!host || allowed.every((origin) => new URL(origin).host !== host)) {
    throw new Error("Host is not allowed. Set CODEX_ALLOWED_ORIGINS on the computer.");
  }

  const origin = request.headers.get("origin");

  if ((mutation && !origin) || (origin && !allowed.includes(origin))) {
    throw new Error("Origin is not allowed.");
  }

  if (mutation && !request.headers.get("content-type")?.startsWith(contentType)) {
    throw new Error(`Expected ${contentType}.`);
  }
}
export async function readBody(request: Request) {
  const reader = request.body?.getReader();

  if (!reader) {
    throw new Error("Missing message.");
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.length;

    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Message is too large.");
    }

    chunks.push(value);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export function errorResponse(error: unknown, status = HTTP_BAD_REQUEST) {
  log().error({ error, status }, "http.failed");

  return Response.json(
    { error: error instanceof Error ? error.message : "Request failed." },
    { status, headers: noStore }
  );
}
