"use client";
import { FileIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { attachmentUrl, fileSize } from "@/lib/attachments";
import { Button } from "./ui/button";
import { ChatImage } from "./chat-image";
import type { DraftAttachment } from "@/hooks/use-attachments";

export function ComposerAttachments({
  files,
  disabled,
  remove,
  retry,
}: {
  files: DraftAttachment[];
  disabled: boolean;
  remove: (id: string) => Promise<void>;
  retry: (file: DraftAttachment) => Promise<void>;
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <ul className="mb-2 flex max-h-52 gap-2 overflow-auto py-1" aria-label="Selected attachments">
      {files.map((entry) => (
        <li key={entry.id} className="w-60 shrink-0 rounded-xl border border-input bg-background p-2">
          <div className="flex items-start gap-2">
            {entry.uploaded?.kind === "image" ? (
              <div className="w-14 shrink-0 overflow-hidden">
                <ChatImage source={attachmentUrl(entry.id, true)} alt={entry.file.name} />
              </div>
            ) : (
              <FileIcon className="mt-2 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1 py-1">
              <p className="truncate text-sm" title={entry.file.name}>
                {entry.file.name}
              </p>
              <p className="truncate text-xs text-muted-foreground" title={entry.file.type}>
                {entry.file.type || "File"} · {fileSize(entry.file.size)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              disabled={disabled}
              aria-label={`Remove ${entry.file.name}`}
              onClick={() => void remove(entry.id)}
            >
              <XIcon />
            </Button>
          </div>
          <div className="text-xs" role="status">
            {entry.error ? (
              <div>
                <p className="text-destructive">{entry.error}</p>
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void retry(entry)}
                  aria-label={`Retry ${entry.file.name}`}
                >
                  <RotateCcwIcon />
                  Retry
                </Button>
              </div>
            ) : entry.uploaded ? (
              <span className="text-muted-foreground">Ready to send</span>
            ) : (
              <>
                <span className="text-muted-foreground">Uploading {entry.progress}%</span>
                <progress
                  className="mt-1 block h-1 w-full"
                  value={entry.progress}
                  max={100}
                  aria-label={`Uploading ${entry.file.name}`}
                />
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
