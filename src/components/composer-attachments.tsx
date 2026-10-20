"use client";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";
import type { DraftAttachment } from "@/hooks/use-attachments";
import { fileSize } from "@/lib/attachments";

/**
Present selected upload progress and expose caller-owned retry/removal actions.
@param props - Draft files, disabled state and callbacks that own each upload operation.
@returns The current composer attachment list.
*/
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
    <ul className="mb-2 flex max-h-52 gap-4 overflow-auto py-1" aria-label="Selected attachments">
      {files.map((entry) => (
        <li key={entry.id} className="w-60 shrink-0 rounded-xl border border-input bg-background px-4 py-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 py-1">
              <p className="truncate text-sm" title={entry.file.name}>
                {entry.file.name}
              </p>
              <p className="flex gap-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate" title={entry.file.type}>
                  {entry.file.type || "File"}
                </span>
                <span className="shrink-0">· {fileSize(entry.file.size)}</span>
              </p>
              <div className="mt-1 text-xs [overflow-wrap:anywhere]" role="status">
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
        </li>
      ))}
    </ul>
  );
}
