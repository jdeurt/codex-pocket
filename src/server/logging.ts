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

export function redactLog(value: unknown): unknown {
  const normalized = value instanceof Error ? pino.stdSerializers.err(value) : value;

  if (Array.isArray(normalized)) {
    return normalized.map((entry) => redactLog(entry));
  }

  return normalized && typeof normalized === "object"
    ? Object.fromEntries(
        Object.entries(normalized).map(([key, entry]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactLog(entry)])
      )
    : normalized;
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

    while (true) {
      filename = path.join(directory, `${new Date(createdAt).toISOString()}.jsonl`);

      try {
        descriptor = openSync(/* turbopackIgnore: true */ filename, "wx", PRIVATE_FILE_MODE);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
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
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
          callback(error as Error);
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
  if (!globalThis.codexPocketLogger) {
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
        formatters: { log: (fields) => redactLog(fields) as Record<string, unknown> },
      },
      stream
    );
    Object.defineProperty(globalThis, "codexPocketLogger", { value: logger, configurable: true });
  }

  return globalThis.codexPocketLogger as pino.Logger;
}
