import { type DraftAttachment } from "../lib/draft-attachments";
import { type FileAttachment, fileAttachmentSchema } from "../lib/attachments";
import { pocketUrl } from "./pocket-navigation";
import { t } from "try";
import { z } from "zod";

const UPLOAD_TIMEOUT_MS = 180_000;
const PERCENT = 100;
const UPLOADING_MAX_PERCENT = 99;
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
const uploadResponseSchema = z.object({ file: fileAttachmentSchema.optional(), error: z.string().optional() });

/** Validate the response before acknowledging an uploaded attachment.
@param source - Server response body.
@returns Validated receipt or server error.
*/
function uploadResponse(source: string) {
  return uploadResponseSchema.parse(JSON.parse(source));
}

/**
Own one native upload, its callbacks, cancellation listener and result.
*/
class FileTransfer {
  private readonly xhr = new XMLHttpRequest();
  private readonly completion = Promise.withResolvers<FileAttachment>();

  /** Publish the browser's transport progress before the validated receipt arrives.
  @param event - Native upload progress.
  */
  private progressed = (event: ProgressEvent) => {
    this.progress(
      event.lengthComputable ? Math.min(UPLOADING_MAX_PERCENT, Math.round((event.loaded * PERCENT) / event.total)) : 0
    );
  };

  /**
  Reject this transfer after disconnection or native cancellation.
  */
  private interrupted = () => {
    this.completion.reject(new Error("Upload interrupted. Retry when connected."));
  };

  /**
  Reject the caller after the native upload timeout.
  */
  private timedOut = () => {
    this.completion.reject(new Error("Upload timed out. Retry when connected."));
  };

  /**
  Validate a completed response and settle exactly this upload.
  */
  private loaded = () => {
    const parsed = t(uploadResponse, this.xhr.responseText);

    if (!parsed.ok) {
      this.completion.reject(new Error("Upload failed. Retry when connected.", { cause: parsed.error }));

      return;
    }

    const result = parsed.value;

    if (this.xhr.status < HTTP_OK || this.xhr.status >= HTTP_REDIRECT || !result.file) {
      this.completion.reject(
        new Error(result.error?.length ? result.error : "Upload failed. Retry or choose another file.")
      );

      return;
    }

    this.completion.resolve(result.file);
  };

  /**
  Cancel the owned native request.
  */
  private abort = () => {
    this.xhr.abort();
  };

  /** Retain explicit transport dependencies.
  @param entry - Original bytes and durable upload identity.
  @param progress - Runtime progress publisher.
  @param signal - Caller-owned cancellation.
  */
  constructor(
    private readonly entry: DraftAttachment,
    private readonly progress: (value: number) => void,
    private readonly signal: AbortSignal
  ) {}

  /** Transfer bytes and release the cancellation listener before propagating the outcome.
  @returns Validated server receipt.
  */
  async run() {
    this.signal.throwIfAborted();
    const { entry, xhr } = this;
    const query = new URLSearchParams({
      id: entry.id,
      name: entry.file.name,
      type: entry.file.type || "application/octet-stream",
    });

    xhr.open("PUT", pocketUrl(`/api/uploads?${query}`));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.addEventListener("progress", this.progressed);
    xhr.addEventListener("error", this.interrupted);
    xhr.addEventListener("abort", this.interrupted);
    xhr.addEventListener("timeout", this.timedOut);
    xhr.addEventListener("load", this.loaded);
    this.signal.addEventListener("abort", this.abort, { once: true });
    const sent = t(xhr.send.bind(xhr), entry.file);

    if (!sent.ok) {
      this.signal.removeEventListener("abort", this.abort);
      throw sent.error;
    }

    const result = await t(this.completion.promise);

    this.signal.removeEventListener("abort", this.abort);

    if (!result.ok) {
      throw result.error;
    }

    return result.value;
  }
}

/** Start an explicitly owned upload without exposing its native request.
@param entry - Draft attachment with original bytes.
@param progress - Runtime progress publisher.
@param signal - Caller-owned cancellation.
@returns Validated upload receipt.
*/
export function uploadFile(entry: DraftAttachment, progress: (value: number) => void, signal: AbortSignal) {
  return new FileTransfer(entry, progress, signal).run();
}
