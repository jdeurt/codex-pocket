import { clientError, reportClient } from "./client-logging";
import { object, string } from "./protocol";

async function request(path: string, options: RequestInit) {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const headers = new Headers(options.headers);

  headers.set("X-Pocket-Request-Id", requestId);
  let response: Response;

  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    reportClient("http.network_error", { path, requestId, ...clientError(error) }, "error");
    throw new Error("Pocket is restarting or unreachable. Your message is saved here.", { cause: error });
  }

  const text = await response.text();

  let data: Record<string, unknown>;

  try {
    data = object(JSON.parse(text));
  } catch (error) {
    reportClient(
      "http.invalid_response",
      {
        path,
        requestId,
        status: response.status,
        contentType: response.headers.get("content-type"),
        response: text,
        ...clientError(error),
      },
      "error"
    );
    throw new Error("Pocket is restarting or returned an unreadable response. Your message is saved here.", {
      cause: error,
    });
  }

  reportClient("http.response", {
    path,
    requestId,
    status: response.status,
    durationMs: performance.now() - startedAt,
  });

  if (!response.ok) {
    reportClient("http.rejected", { path, requestId, status: response.status, error: data.error }, "error");
    throw new Error(string(data.error) || "Couldn't send. Your message is saved here.");
  }

  return data;
}

export const get = (path: string, signal: AbortSignal) => request(path, { signal });

export const post = (path: string, data: unknown) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
