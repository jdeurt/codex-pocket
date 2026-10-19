import { type FileAttachment, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES } from "../lib/attachments";
import { localDirectory, readLocal, writeLocal } from "./local-state";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import type { Receipt } from "./outbox";
import type { Snapshot } from "../lib/protocol";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";

const uuid = z.string().uuid();
const MAX_NAME_LENGTH = 240;
const MAX_MEDIA_TYPE_LENGTH = 120;
const PRIVATE_FILE_MODE = 0o600;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_EDGE = 2048;
const rasterFormats = new Set(["png", "jpeg", "webp", "gif", "avif", "heif", "tiff"]);
const LAST_CONTROL_CHARACTER = 31;
const DELETE_CHARACTER = 127;
const rasterTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/tiff",
]);
interface StoredUpload extends FileAttachment {
  sha256: string;
}

function directory(parent: string, id: string) {
  uuid.parse(id);

  return path.join(localDirectory(), "uploads", createHash("sha256").update(parent).digest("hex"), id);
}

export function uploadPath(parent: string, file: FileAttachment, image = false) {
  return path.join(directory(parent, file.id), image ? "image.png" : "original");
}

export async function getUpload(parent: string, id: string): Promise<StoredUpload> {
  const file = await readLocal<StoredUpload | null>(path.join(directory(parent, id), "metadata.json"), null);

  if (!file) {
    throw new Error("This file is unavailable in this chat. Choose it again.");
  }

  return file;
}

export function publicUpload(file: FileAttachment): FileAttachment {
  const { id, name, size, mediaType, kind } = file;

  return { id, name, size, mediaType, kind };
}

async function writeBytes(request: Request, pending: string) {
  const declared = Number(request.headers.get("content-length"));

  if (declared > MAX_FILE_BYTES) {
    throw new Error("Each file must be 25 MB or smaller.");
  }

  if (!request.body) {
    throw new Error("Choose a nonempty file.");
  }

  await mkdir(pending, { recursive: true, mode: 0o700 });
  const handle = await open(path.join(pending, "original"), "wx", PRIVATE_FILE_MODE);
  const hash = createHash("sha256");
  const reader = request.body.getReader();
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      size += chunk.value.length;

      if (size > MAX_FILE_BYTES) {
        throw new Error("Each file must be 25 MB or smaller.");
      }

      hash.update(chunk.value);
      await handle.writeFile(chunk.value);
    }
  } finally {
    await handle.close();

    try {
      await reader.cancel();
    } catch {
      /*
      A disconnected request has already closed its body.
      */
    }
  }

  if (!size) {
    throw new Error("This file is empty. Choose a nonempty file.");
  }

  return { size, sha256: hash.digest("hex") };
}

async function normalizeImage(pending: string) {
  try {
    // Normalize supported raster photos to the protocol's widely supported PNG input.
    const image = sharp(path.join(pending, "original"), { limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
    const metadata = await image.metadata();

    if (!metadata.format || !rasterFormats.has(metadata.format)) {
      throw new Error("Unsupported raster image.");
    }

    await image
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
      .png()
      .toFile(path.join(pending, "image.png"));
  } catch {
    throw new Error("This image couldn't be read. Try a PNG, JPEG, WebP, GIF, or AVIF image, or choose another file.");
  }
}

function sameUpload(file: StoredUpload, other: StoredUpload) {
  if (file.sha256 !== other.sha256 || file.name !== other.name || file.mediaType !== other.mediaType) {
    throw new Error("Upload ID already belongs to another file.");
  }
}

async function commitUpload(parent: string, pending: string, file: StoredUpload) {
  await writeLocal(path.join(pending, "metadata.json"), file);

  // Renaming a complete directory commits all bytes and metadata together.
  try {
    await rename(pending, directory(parent, file.id));
  } catch {
    sameUpload(file, await getUpload(parent, file.id));
  }
}

function validName(value: string) {
  return (
    value !== "." &&
    value !== ".." &&
    [...value].every(
      (character) =>
        !(
          (character.codePointAt(0) ?? 0) <= LAST_CONTROL_CHARACTER ||
          character.codePointAt(0) === DELETE_CHARACTER ||
          character === "/" ||
          character === "\\"
        )
    )
  );
}

function imageUpload(name: string, mediaType: string) {
  return (
    rasterTypes.has(mediaType) ||
    (mediaType === "application/octet-stream" && /\.(?:png|jpe?g|webp|gif|avif|hei[cf]|tiff?)$/i.test(name))
  );
}

// The caller supplies an ID, never a storage path. Originals are immutable and private.
export async function saveUpload(parent: string, id: string, request: Request) {
  const url = new URL(request.url);
  const name = z
    .string()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine(validName, "Choose a file with a valid name.")
    .parse(url.searchParams.get("name"));
  const mediaType = z
    .string()
    .max(MAX_MEDIA_TYPE_LENGTH)
    .regex(/^[\w.+-]+\/[\w.+-]+$/)
    .parse(url.searchParams.get("type") || "application/octet-stream");
  const pending = `${directory(parent, id)}.${crypto.randomUUID()}.tmp`;

  try {
    const { size, sha256 } = await writeBytes(request, pending);
    const kind = imageUpload(name, mediaType) ? "image" : "file";
    const file: StoredUpload = { id, name, size, mediaType, kind, sha256 };
    const existing = await readLocal<StoredUpload | null>(path.join(directory(parent, id), "metadata.json"), null);

    if (existing) {
      sameUpload(file, existing);

      return publicUpload(existing);
    }

    if (kind === "image") {
      await normalizeImage(pending);
    }

    await commitUpload(parent, pending, file);

    return publicUpload(file);
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

export async function resolveUploads(parent: string, ids: string[]) {
  if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) {
    throw new Error("Attach up to 10 different files.");
  }

  const files = await Promise.all(
    ids.map(async (id) => {
      const file = await getUpload(parent, id);
      const info = await stat(uploadPath(parent, file));

      if (!info.isFile() || info.size !== file.size) {
        throw new Error(`Choose ${file.name} again; its stored file is unavailable.`);
      }

      return publicUpload(file);
    })
  );

  if (files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachments must total 50 MB or less.");
  }

  return files;
}

export async function downloadUpload(parent: string, id: string) {
  const file = await getUpload(parent, id);

  return { file, bytes: await readFile(uploadPath(parent, file)) };
}

export function attachmentInput(parent: string, files: FileAttachment[]) {
  return files.map((file) =>
    file.kind === "image"
      ? { type: "localImage", path: uploadPath(parent, file, true) }
      : {
          type: "text",
          text: `Attached file on this computer (read it using your file tools):\n${JSON.stringify({ name: file.name, mediaType: file.mediaType, size: file.size, path: uploadPath(parent, file) })}`,
          text_elements: [],
        }
  );
}

export function projectAttachments(state: Snapshot, receipts: Receipt[]) {
  const attached = new Map(receipts.filter((entry) => entry.attachments?.length).map((entry) => [entry.id, entry]));

  for (const turn of state.turns) {
    for (const item of turn.items) {
      const receipt = attached.get(String(item.clientId));

      if (!(item.type === "userMessage" && receipt)) {
        continue;
      }

      item.attachments = receipt.attachments;
      item.pocketAttachmentText = receipt.text;
    }
  }
}

export function assertMessageContent(receipt: Receipt, text: string, ids: string[]) {
  const sameFiles = JSON.stringify(receipt.attachments?.map((file) => file.id) ?? []) === JSON.stringify(ids);

  if (receipt.text !== text || !sameFiles) {
    throw new Error("Message ID already belongs to different content.");
  }
}
