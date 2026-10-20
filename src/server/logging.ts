import { type WriteStream, createWriteStream, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { Writable } from "node:stream";
import { localDirectory } from "./local-state";
import path from "node:path";
import pino from "pino";

const DEFAULT_MAX_BYTES = 10_485_760;
const DEFAULT_MAX_FILES = 20;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const LOG_NAME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\.jsonl$/;
const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|password|secret|token|access_token|refresh_token|api[_-]?key|privateKey|auth|p256dh)$/i;

export function redactLog(value: Record<string, unknown>): Record<string, unknown>;
export function redactLog(value: unknown): unknown;
export function redactLog(value: unknown): unknown {
  const normalized = value instanceof Error ? pino.stdSerializers.err(value) : value;

  if (typeof normalized === "string" && normalized.startsWith("data:image/")) {
    return { inlineImageLength: normalized.length };
  }

  if (Array.isArray(normalized)) {
    return normalized.map((entry) => redactLog(entry));
  }

  if (!(normalized && typeof normalized === "object")) {
    return normalized;
  }

  const image = "type" in normalized ? normalized.type : undefined;

  return Object.fromEntries<unknown>(
    Object.entries(normalized).map(([key, entry]) => {
      const binary =
        typeof entry === "string" &&
        ((image === "imageGeneration" && key === "result") || (image === "image" && key === "data"));

      return [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : binary ? { imageBytesBase64Length: entry.length } : redactLog(entry),
      ];
    })
  );
}

export function createRotatingLogStream(directory: string, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Log size and retention must be positive integers.");
  }

  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  let bytes = 0;
  let createdAt = 0;
  let file: WriteStream;

  const reference: { stream?: Writable } = {};

  function open() {
    createdAt = Math.max(Date.now(), createdAt + 1);
    let filename: string;
    let descriptor: number;

    for (;;) {
      filename = path.join(directory, `${new Date(createdAt).toISOString()}.jsonl`);

      try {
        descriptor = openSync(/* turbopackIgnore: true */ filename, "wx", PRIVATE_FILE_MODE);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }

        createdAt += 1;
      }
    }

    bytes = 0;
    const files = readdirSync(directory)
      .filter((name) => LOG_NAME.test(name))
      .sort((a, b) => a.localeCompare(b));

    for (const name of files.slice(0, Math.max(0, files.length - maxFiles))) {
      try {
        unlinkSync(path.join(directory, name));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    const output = createWriteStream(filename, { fd: descriptor, autoClose: true });

    output.on("error", (error) => reference.stream?.destroy(error));

    return output;
  }

  const stream = new Writable({
    write(chunk: Buffer, encoding, callback) {
      const write = () => {
        bytes += chunk.length;
        file.write(chunk, encoding, callback);
      };

      if (bytes === 0 || bytes + chunk.length <= maxBytes) {
        write();

        return;
      }

      file.end(() => {
        try {
          file = open();
          write();
        } catch (error) {
          callback(error instanceof Error ? error : new Error("Could not rotate the log.", { cause: error }));
        }
      });
    },
    final(callback) {
      file.end(callback);
    },
  });

  reference.stream = stream;
  file = open();

  return stream;
}

declare global {
  var codexPocketLogger: pino.Logger | undefined;
}

export function log() {
  const existing = globalThis.codexPocketLogger;

  if (existing) {
    return existing;
  }

  const directory = process.env.CODEX_POCKET_LOG_DIR ?? path.join(localDirectory(), "logs");
  const stream = createRotatingLogStream(
    directory,
    Number(process.env.CODEX_POCKET_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    Number(process.env.CODEX_POCKET_LOG_MAX_FILES ?? DEFAULT_MAX_FILES)
  );

  stream.on("error", (error) => process.stderr.write(`Pocket log writer failed: ${error.message}\n`));
  const logger = pino(
    {
      name: "pocket",
      level: process.env.CODEX_POCKET_LOG_LEVEL ?? "debug",
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { log: (fields) => redactLog(fields) },
    },
    stream
  );

  Object.defineProperty(globalThis, "codexPocketLogger", { value: logger, configurable: true });

  return logger;
}
