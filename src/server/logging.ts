import { type WriteStream, createWriteStream, closeSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { Writable } from "node:stream";
import { localDirectory } from "./local-state";
import path from "node:path";
import pino from "pino";
import { t } from "try";
import { redactLog } from "../lib/log-redaction";

export { redactLog } from "../lib/log-redaction";

const DEFAULT_MAX_BYTES = 10_485_760;
const DEFAULT_MAX_FILES = 20;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const LOG_NAME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\.jsonl$/;

type WriteCallback = (error?: Error | null) => void;

/** Order timestamped files deterministically.
@param left - First filename.
@param right - Second filename.
@returns Chronological filename order.
*/
function compareLogFiles(left: string, right: string) {
  return left.localeCompare(right);
}

/** Prune only owned files after acquiring a new exclusive log file.
@param directory - Private log directory.
@param maxFiles - Maximum owned file count.
*/
function pruneLogs(directory: string, maxFiles: number) {
  const names: string[] = [];

  for (const name of readdirSync(directory)) {
    if (LOG_NAME.test(name)) {
      names.push(name);
    }
  }

  const files = names.toSorted(compareLogFiles);
  const expired = files.slice(0, Math.max(0, files.length - maxFiles));

  for (const name of expired) {
    const removed = t(unlinkSync, path.join(directory, name));

    if (
      !removed.ok &&
      !(removed.error instanceof Error && "code" in removed.error && removed.error.code === "ENOENT")
    ) {
      throw removed.error;
    }
  }
}

/** Acquire a timestamped descriptor exclusively with private permissions.
@param filename - Explicit host-generated pathname.
@returns Owned native descriptor.
*/
function openLogDescriptor(filename: string) {
  return openSync(/* turbopackIgnore: true */ filename, "wx", PRIVATE_FILE_MODE);
}

/**
Runtime owner of serialized native writes and bounded file rotation.
*/
class RotatingLogStream extends Writable {
  private bytes = 0;
  private createdAt = 0;
  private file: WriteStream;

  /** Route asynchronous file errors through the owning native sink.
  @param error - Native file failure.
  */
  private fail = (error: Error) => {
    this.destroy(error);
  };

  /** Acquire an exclusive native file and prune owned expired logs.
  @returns Native stream owning the descriptor.
  */
  private open = () => {
    this.createdAt = Math.max(Date.now(), this.createdAt + 1);

    for (;;) {
      const filename = path.join(this.directory, `${new Date(this.createdAt).toISOString()}.jsonl`);
      const opened = t(openLogDescriptor, filename);

      if (!opened.ok) {
        if (!(opened.error instanceof Error && "code" in opened.error && opened.error.code === "EEXIST")) {
          throw opened.error;
        }

        this.createdAt++;
        continue;
      }

      const pruned = t(pruneLogs, this.directory, this.maxFiles);

      if (!pruned.ok) {
        closeSync(opened.value);
        throw pruned.error;
      }

      const output = createWriteStream(filename, { fd: opened.value, autoClose: true });

      output.on("error", this.fail);
      this.bytes = 0;

      return output;
    }
  };

  /** Start one sink with validated retention limits.
  @param directory - Existing private directory.
  @param maxBytes - Per-file byte threshold.
  @param maxFiles - Maximum retained files.
  */
  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number
  ) {
    super();
    this.file = this.open();
  }

  /** Write one complete record to the current file.
  @param chunk - Native record bytes.
  @param encoding - Native write encoding.
  @param callback - Native backpressure completion.
  */
  private writeRecord(chunk: Buffer, encoding: BufferEncoding, callback: WriteCallback) {
    this.bytes += chunk.length;
    this.file.write(chunk, encoding, callback);
  }

  /** Complete rotation after the previous file finishes.
  @param chunk - Pending native record bytes.
  @param encoding - Native write encoding.
  @param callback - Native backpressure completion.
  */
  private rotated(chunk: Buffer, encoding: BufferEncoding, callback: WriteCallback) {
    const opened = t(this.open);

    if (!opened.ok) {
      callback(
        opened.error instanceof Error ? opened.error : new Error("Could not rotate the log.", { cause: opened.error })
      );

      return;
    }

    this.file = opened.value;
    this.writeRecord(chunk, encoding, callback);
  }

  /** Preserve record boundaries and native backpressure during rotation.
  @param chunk - Complete serialized log record.
  @param encoding - Native write encoding.
  @param callback - Native backpressure completion.
  */
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: WriteCallback) {
    if (this.bytes === 0 || this.bytes + chunk.length <= this.maxBytes) {
      this.writeRecord(chunk, encoding, callback);
    } else {
      this.file.end(this.rotated.bind(this, chunk, encoding, callback));
    }
  }

  /** Finish the current native file before completing the sink.
  @param callback - Native finalization completion.
  */
  override _final(callback: WriteCallback) {
    this.file.end(callback);
  }
}

/** Validate retention and acquire a private rotating sink.
@param directory - Private log directory.
@param maxBytes - Positive per-file byte threshold.
@param maxFiles - Positive retained file count.
@returns Native backpressure-aware rotating sink.
*/
export function createRotatingLogStream(directory: string, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("Log size and retention must be positive integers.");
  }

  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  return new RotatingLogStream(directory, maxBytes, maxFiles);
}

declare global {
  var codexPocketLogger: pino.Logger | undefined;
}

/** Report a failed sink through stderr, independent of the failed logger.
@param error - Native sink failure.
*/
function reportLogError(error: Error) {
  process.stderr.write(`Pocket log writer failed: ${error.message}\n`);
}

/** Acquire the configured process logger and register its explicit singleton lifetime.
@returns Native structured logger.
*/
function createLogger() {
  const directory = process.env.CODEX_POCKET_LOG_DIR ?? path.join(localDirectory(), "logs");
  const stream = createRotatingLogStream(
    directory,
    Number(process.env.CODEX_POCKET_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES),
    Number(process.env.CODEX_POCKET_LOG_MAX_FILES ?? DEFAULT_MAX_FILES)
  );

  stream.on("error", reportLogError);
  const logger = pino(
    {
      name: "pocket",
      level: process.env.CODEX_POCKET_LOG_LEVEL ?? "debug",
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { log: redactLog },
    },
    stream
  );

  Object.defineProperty(globalThis, "codexPocketLogger", { value: logger, configurable: true });

  return logger;
}

/** Reuse the process-owned logger or acquire its configured sink.
@returns Process-local structured logger.
*/
export function log() {
  return globalThis.codexPocketLogger ?? createLogger();
}
