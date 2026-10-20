import { clientError, reportClient } from "./client-logging";
import { object, string } from "./protocol";

/**
Fetch one request with a correlation header and a recoverable network error.
@param path - Same-origin API path to request.
@param options - Fetch options, including any caller-owned cancellation signal.
@param requestId - Identifier shared by client and server diagnostics.
@returns The response without consuming its body.
*/
async function fetchResponse(path: string, options: RequestInit, requestId: string) {
  const headers = new Headers(options.headers);

  headers.set("X-Pocket-Request-Id", requestId);

  try {
    return await fetch(path, { ...options, headers });
  } catch (error) {
    reportClient("http.network_error", { path, requestId, ...clientError(error) }, "error");
    throw new Error("Pocket is restarting or unreachable. Your message is saved here.", { cause: error });
  }
}

/**
Consume an API response and normalize its unchecked JSON object once.
@param response - Fetch response whose body has not been consumed.
@param path - API path recorded if parsing fails.
@param requestId - Identifier of the original request.
@returns The decoded object, with individual fields left unknown.
*/
async function responseData(response: Response, path: string, requestId: string) {
  const text = await response.text();

  try {
    return object(JSON.parse(text));
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
}

/**
Request API JSON and report network, parsing and HTTP failures.
@param path - Same-origin API path to request.
@param options - Fetch options for this operation.
@returns A normalized successful response object with unchecked field values.
*/
async function request(path: string, options: RequestInit) {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const response = await fetchResponse(path, options, requestId);
  const data = await responseData(response, path, requestId);

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

/**
Read API JSON with cancellation owned by the caller.
@param path - Same-origin API path to read.
@param signal - Signal that cancels this read.
@returns The successful response object.
*/
export const get = (path: string, signal: AbortSignal) => request(path, { signal });

/**
Send a JSON mutation and surface a recoverable error if it fails.
@param path - Same-origin mutation endpoint.
@param data - Payload serialized without changing the caller's value.
@returns The successful response object.
*/
export const post = (path: string, data: unknown) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
