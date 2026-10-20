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

/**
Recursively redact private fields and native image bytes while preserving structured diagnostics.
@param value - Arbitrary diagnostic data, including native errors and nested arrays or objects.
@returns The same diagnostic structure with secret and binary payload fields replaced.
*/
export function redactLog(value: Record<string, unknown>): Record<string, unknown>;
export function redactLog(value: unknown): unknown;
export function redactLog(value: unknown): unknown {
  function redactImageField(key: string, entry: unknown, image: unknown): unknown {
    const isBinary =
      typeof entry === "string" &&
      ((image === "imageGeneration" && key === "result") || (image === "image" && key === "data"));

    return isBinary ? { imageBytesBase64Length: entry.length } : redactLog(entry);
  }

  function redactField(key: string, entry: unknown, image: unknown): unknown {
    return SECRET_KEY.test(key) ? "[REDACTED]" : redactImageField(key, entry, image);
  }

  function redactObject(value_: object) {
    const image = "type" in value_ ? value_.type : undefined;

    return Object.fromEntries<unknown>(
      Object.entries(value_).map(([key, entry]: [string, unknown]) => [key, redactField(key, entry, image)])
    );
  }

  const normalized = value instanceof Error ? pino.stdSerializers.err(value) : value;

  if (typeof normalized === "string" && normalized.startsWith("data:image/")) {
    return { inlineImageLength: normalized.length };
  }

  if (Array.isArray(normalized)) {
    return normalized.map((entry) => redactLog(entry));
  }

  return normalized && typeof normalized === "object" ? redactObject(normalized) : normalized;
}

/**
Prune only owned timestamped log files after a new exclusive file has been acquired.
@param directory - Private log directory whose native entries are inspected.
@param maxFiles - Maximum retained owned log files, including the newly acquired file.
*/
function pruneLogs(directory: string, maxFiles: number) {
  const files = readdirSync(directory)
    .filter((name) => LOG_NAME.test(name))
    .toSorted((a, b) => a.localeCompare(b));
  const expired = files.slice(0, Math.max(0, files.length - maxFiles));

  for (const name of expired) {
    try {
      unlinkSync(path.join(directory, name));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
}

/**
Attach an acquired private descriptor to its native stream and route errors to the owning sink.
@param filename - Timestamped log filename already opened exclusively.
@param descriptor - Owned native descriptor transferred to the auto-closing stream.
@param reference - Concrete sink reference receiving asynchronous file-stream failures.
@returns Native write stream owning this descriptor.
*/
function ownedLogFile(filename: string, descriptor: number, reference: { stream?: Writable }) {
  const output = createWriteStream(filename, { fd: descriptor, autoClose: true });

  output.on("error", (error) => reference.stream?.destroy(error));

  return output;
}

/**
Own serialized native writes, exclusive file creation and bounded log rotation.
@param directory - Existing private log directory.
@param maxBytes - Existing per-file byte threshold; a single oversized record stays intact.
@param maxFiles - Maximum retained owned timestamped files.
@returns Backpressure-aware native writable sink that rotates only between records.
*/
function rotatingLogStream(directory: string, maxBytes: number, maxFiles: number) {
  let bytes = 0;
  let createdAt = 0;
  let file: WriteStream;

  const reference: { stream?: Writable } = {};

  function open() {
    let filename: string;
    let descriptor: number;

    createdAt = Math.max(Date.now(), createdAt + 1);

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
    pruneLogs(directory, maxFiles);

    return ownedLogFile(filename, descriptor, reference);
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

/**
Validate retention limits and create the private directory before acquiring the rotating sink.
@param directory - Private directory used only for this logger's owned files.
@param maxBytes - Positive per-file byte threshold.
@param maxFiles - Positive retained file count.
@returns Native rotating log sink with private file and directory permissions.
*/
export function createRotatingLogStream(directory: string, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Log size and retention must be positive integers.");
  }

  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  return rotatingLogStream(directory, maxBytes, maxFiles);
}

declare global {
  var codexPocketLogger: pino.Logger | undefined;
}

/**
Create the native structured logger and register its existing process singleton descriptor.
@param stream - Owned rotating writable sink whose error listener is already installed.
@returns Registered native Pino logger.
*/
function registerLogger(stream: Writable) {
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

/**
Acquire the configured private log sink and route sink failures before registering Pino.
@returns New process logger with the existing level, timestamps and recursive redaction.
*/
function createLogger() {
  const directory = process.env.CODEX_POCKET_LOG_DIR ?? path.join(localDirectory(), "logs");
  const stream = createRotatingLogStream(
    directory,
    Number(process.env.CODEX_POCKET_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    Number(process.env.CODEX_POCKET_LOG_MAX_FILES ?? DEFAULT_MAX_FILES)
  );

  stream.on("error", (error) => process.stderr.write(`Pocket log writer failed: ${error.message}\n`));

  return registerLogger(stream);
}

/**
Reuse the process logger or acquire its configured private sink on first use.
@returns Process-local structured logger.
*/
export function log() {
  return globalThis.codexPocketLogger ?? createLogger();
}
