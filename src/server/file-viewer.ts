import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readConfig } from "./config";

const MAX_FILE_BYTES = 67_108_864;
const MAX_MARKDOWN_BYTES = 2_097_152;
const types: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

/**
Resolve one authorized local file without fetching remote URLs or reading devices/directories.
@param source - Local path or file URL selected by the phone.
@returns Canonical filename, native MIME type, size and optional Markdown source.
*/
export async function viewerFile(source: string) {
  const config = await readConfig();

  if (!config || (/^[a-z][\w+.-]*:/i.test(source) && !source.startsWith("file:"))) {
    throw new Error("A configured Pocket and a local file are required.");
  }

  const filename = await realpath(
    source.startsWith("file:") ? fileURLToPath(source) : path.resolve(config.cwd, source)
  );
  const info = await stat(filename);
  const type = types[path.extname(filename).toLowerCase()] ?? "application/octet-stream";

  if (!info.isFile() || info.size > MAX_FILE_BYTES || (type === "text/markdown" && info.size > MAX_MARKDOWN_BYTES)) {
    throw new Error("File is unavailable or too large to display.");
  }

  return {
    filename,
    name: path.basename(filename),
    type,
    size: info.size,
    markdown: type === "text/markdown" ? await readFile(filename, "utf8") : null,
  };
}
