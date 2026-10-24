import { type FileHandle, mkdir, open } from "node:fs/promises";
import { type Hash, createHash } from "node:crypto";
import { MAX_FILE_BYTES } from "../lib/attachments";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;

/**
Copy request chunks sequentially while enforcing the actual byte limit.
@param file - New private file receiving original bytes.
@param reader - Reader for the request body.
@param hash - Digest updated in the same order as file writes.
@returns The number of bytes successfully consumed.
*/
async function copyUploadBody(file: FileHandle, reader: ReadableStreamDefaultReader<Uint8Array>, hash: Hash) {
  let size = 0;

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    size += chunk.value.length;

    if (size > MAX_FILE_BYTES) {
      throw new Error("Each file must be 25 MB or smaller.");
    }

    hash.update(chunk.value);
    await file.writeFile(chunk.value);
  }

  return size;
}

/**
Close the file before cancelling its reader on success or failure.
@param file - File handle owned by this upload.
@param reader - Reader owned by this upload.
@param hash - Digest accumulator for the original bytes.
@returns The consumed byte count.
*/
async function ownedUploadBody(file: FileHandle, reader: ReadableStreamDefaultReader<Uint8Array>, hash: Hash) {
  return copyUploadBody(file, reader, hash).finally(async () => {
    await file.close();

    await reader.cancel().catch(() => {
      // A disconnected request has already closed its body.
    });
  });
}

/**
Hash and persist a nonempty request body without transforming its bytes.
@param file - New private upload file.
@param body - Readable request body.
@returns Original size and SHA-256 digest.
*/
async function uploadContents(file: FileHandle, body: ReadableStream<Uint8Array>) {
  const hash = createHash("sha256");
  const reader = body.getReader();
  const size = await ownedUploadBody(file, reader, hash);

  if (!size) {
    throw new Error("This file is empty. Choose a nonempty file.");
  }

  return { size, sha256: hash.digest("hex") };
}

/**
Create the private pending directory before exclusively opening its original file.
@param body - Readable request body.
@param pending - Unique pending upload directory.
@returns Original size and digest after the file has closed.
*/
async function pendingUpload(body: ReadableStream<Uint8Array>, pending: string) {
  await mkdir(pending, { recursive: true, mode: 0o700 });

  return uploadContents(await open(path.join(pending, "original"), "wx", PRIVATE_FILE_MODE), body);
}

/**
Reject oversized declarations and absent bodies before creating pending storage.
@param request - Incoming upload request.
@param pending - Unique pending upload directory.
@returns The persisted original size and digest.
*/
export async function writeBytes(request: Request, pending: string) {
  const declared = Number(request.headers.get("content-length"));

  if (declared > MAX_FILE_BYTES) {
    throw new Error("Each file must be 25 MB or smaller.");
  }

  if (!request.body) {
    throw new Error("Choose a nonempty file.");
  }

  return pendingUpload(request.body, pending);
}
