import pino from "pino";

const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|password|secret|token|access_token|refresh_token|api[_-]?key|privateKey|auth|p256dh)$/i;

/** Redact private fields and native image bytes without changing the source diagnostics.
@param value - Explicit diagnostic value, including native errors.
@returns Detached diagnostic structure with secrets and binary payloads replaced.
*/
export function redactLog(value: Record<string, unknown>): Record<string, unknown>;
export function redactLog(value: unknown): unknown;
export function redactLog(value: unknown): unknown {
  const normalized = value instanceof Error ? pino.stdSerializers.err(value) : value;

  if (typeof normalized === "string" && normalized.startsWith("data:image/")) {
    return { inlineImageLength: normalized.length };
  }

  if (Array.isArray(normalized)) {
    return Array.from(normalized, redactLog);
  }

  if (!normalized || typeof normalized !== "object") {
    return normalized;
  }

  const image = "type" in normalized ? normalized.type : undefined;
  const entries: [string, unknown][] = [];

  for (const [key, entry] of Object.entries(normalized)) {
    if (SECRET_KEY.test(key)) {
      entries.push([key, "[REDACTED]"]);
      continue;
    }

    const isBinary =
      typeof entry === "string" &&
      ((image === "imageGeneration" && key === "result") || (image === "image" && key === "data"));

    entries.push([key, isBinary ? { imageBytesBase64Length: entry.length } : redactLog(entry)]);
  }

  return Object.fromEntries(entries);
}
