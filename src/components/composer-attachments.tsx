"use client";
import { RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";
import type { DraftAttachment } from "@/hooks/use-attachments";
import { retryAttachment, removeAttachment } from "@/runtime/attachment-actions";
import { fileSize } from "@/lib/attachments";

/**
Present the current upload outcome without changing retry ownership or byte transport.
@param props - Draft entry, disabled state and caller-owned retry operation.
@returns The existing error/retry controls, ready label or native progress indicator.
*/
function AttachmentProgress({
  entry,
  disabled,
  retry,
}: {
  entry: DraftAttachment;
  disabled: boolean;
  retry: (file: DraftAttachment) => Promise<void>;
}) {
  if (entry.error) {
    return (
      <div>
        <p className="text-destructive">{entry.error}</p>
        <Button
          type="button"
          size="sm"
          className="min-h-11"
          variant="ghost"
          disabled={disabled}
          onClick={retryAttachment.bind(undefined, retry, entry)}
          aria-label={`Retry ${entry.file.name}`}
        >
          <RotateCcwIcon />
          Retry
        </Button>
      </div>
    );
  }

  return entry.uploaded ? (
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
  );
}

/** Render a draft attachment with its explicit native actions.
@param isDisabled - Whether controls are locked.
@param remove - Owning removal operation.
@param retry - Owning upload operation.
@param entry - Draft attachment.
@returns Stable attachment row.
*/
function attachmentRow(
  isDisabled: boolean,
  remove: (id: string) => Promise<void>,
  retry: (file: DraftAttachment) => Promise<void>,
  entry: DraftAttachment
) {
  return (
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
            <AttachmentProgress entry={entry} disabled={isDisabled} retry={retry} />
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          disabled={isDisabled}
          aria-label={`Remove ${entry.file.name}`}
          onClick={removeAttachment.bind(undefined, remove, entry.id)}
        >
          <XIcon />
        </Button>
      </div>
    </li>
  );
}

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
      {Array.from(files, attachmentRow.bind(undefined, disabled, remove, retry))}
    </ul>
  );
}
