"use client";
import "./file-viewer.css";
import { useEffect, useReducer } from "react";
import { useStore } from "zustand";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Markdown } from "./markdown";
import { useRouter } from "next/navigation";
import { PocketNavigationContext } from "../providers/pocket-navigation-context";
import { FileViewerRuntime, type FileViewerOptions } from "../runtime/file-viewer";
import { type FileMetadata } from "../state/file-viewer";

const LAST_COMPONENT = -1;

/**
Render loaded Markdown with chat semantics or let the browser handle a native file.
@param props - Validated file metadata, load error and same-origin content URL.
@returns Content appropriate to the current loading state.
*/
function FileContent({ file, error, url }: { file: FileMetadata | null; error: string; url: string }) {
  if (error) {
    return <p role="alert">{error}</p>;
  }

  if (!file) {
    return <p role="status">Loading…</p>;
  }

  if (file.type === "application/octet-stream") {
    return (
      <a href={url} download={file.name}>
        Download {file.name}
      </a>
    );
  }

  if (file.markdown === null) {
    return <iframe title={file.name} src={url} sandbox="allow-same-origin allow-downloads" />;
  }

  return (
    <Markdown allowCopyActions fileBase={file.filename}>
      {file.markdown}
    </Markdown>
  );
}

/** Create the runtime for one explicitly keyed file route.
@param options - Initial route and navigation dependencies.
@returns Unmounted file-view owner.
*/
function createFileView(options: FileViewerOptions) {
  return new FileViewerRuntime(options);
}

/** Retain the runtime until the keyed route remounts.
@param runtime - Mounted view owner.
@returns The same runtime.
*/
function retainFileView(runtime: FileViewerRuntime) {
  return runtime;
}

/** Render validated file state and bind explicit runtime event handlers.
@param props - Original path, conversation scope and overlay navigation mode.
@returns Full-screen file surface with native back navigation.
*/
export function FileViewer({
  filename,
  pocketId = "main",
  overlay = false,
}: {
  filename: string;
  pocketId?: string;
  overlay?: boolean;
}) {
  const router = useRouter();
  const [runtime] = useReducer(retainFileView, { filename, pocketId, overlay, router }, createFileView);
  const { dialog, store, connect, cancel, down, move, up, cancelGesture, back, url } = runtime;
  const { file, error, offset } = useStore(store);

  useEffect(connect, [connect]);

  return (
    <PocketNavigationContext value={pocketId}>
      <dialog
        ref={dialog}
        className="file-viewer"
        aria-label={file?.name ?? "File"}
        style={{ transform: `translateX(${String(offset)}px)` }}
        onCancel={cancel}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancelGesture}
      >
        <header className="file-viewer-header">
          <Button variant="ghost" size="icon-xl" aria-label="Back to chat" onClick={back}>
            <ArrowLeftIcon />
          </Button>
          <h1 title={file?.name}>{file?.name ?? filename.split("/").at(LAST_COMPONENT)}</h1>
        </header>
        <div className="file-viewer-edge" aria-hidden="true" />
        <div className="file-viewer-content">
          <FileContent file={file} error={error} url={url} />
        </div>
      </dialog>
    </PocketNavigationContext>
  );
}
