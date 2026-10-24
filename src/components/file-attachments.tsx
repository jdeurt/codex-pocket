"use client";
import { type FileAttachment, fileSize } from "@/lib/attachments";
import { FileIcon } from "lucide-react";

/** Render one durable attachment without interaction or browser reads.
@param file - Validated original-file metadata.
@returns One keyed attachment row.
*/
function fileAttachment(file: FileAttachment) {
  return (
    <li key={file.id} className="flex w-full min-w-0 items-center gap-4 rounded-lg bg-muted/60 px-4 py-2 text-sm">
      <FileIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={file.name}>
          {file.name}
        </span>
        <span className="flex gap-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={file.mediaType}>
            {file.mediaType}
          </span>
          <span className="shrink-0">· {fileSize(file.size)}</span>
        </span>
      </span>
    </li>
  );
}

/**
Render durable file metadata as noninteractive full-width attachment rows.
@param props - Normalized attachment metadata supplied by the shared protocol schema.
@returns Static file rows, or null for an empty list.
*/
export function FileAttachments({ files }: { files: FileAttachment[] }) {
  if (files.length === 0) {
    return null;
  }

  return (
    <ul className="flex w-full min-w-0 flex-col gap-4" aria-label="Attachments">
      {Array.from(files, fileAttachment)}
    </ul>
  );
}
