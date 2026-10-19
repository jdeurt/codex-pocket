"use client";
import { DownloadIcon, FileIcon } from "lucide-react";
import { type FileAttachment, attachmentUrl, fileSize } from "@/lib/attachments";
import { ChatImage } from "./chat-image";

export function FileAttachments({ files }: { files: FileAttachment[] }) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex max-w-full flex-wrap gap-2" aria-label="Attachments">
      {files.map((file) => (
        <div key={file.id} className="min-w-0 max-w-full">
          {file.kind === "image" && <ChatImage source={attachmentUrl(file.id, true)} alt={file.name} />}
          <a
            href={attachmentUrl(file.id)}
            download={file.name}
            className="flex min-h-11 max-w-64 items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Download ${file.name}, ${fileSize(file.size)}`}
          >
            <FileIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate" title={file.name}>
                {file.name}
              </span>
              <span className="block break-all text-xs text-muted-foreground">
                {file.mediaType} · {fileSize(file.size)}
              </span>
            </span>
            <DownloadIcon className="ml-auto size-4 shrink-0" aria-hidden="true" />
          </a>
        </div>
      ))}
    </div>
  );
}
