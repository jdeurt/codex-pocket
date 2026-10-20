"use client";
import "./file-viewer.css";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Markdown } from "./markdown";
import { useRouter } from "next/navigation";
import { z } from "zod";

const fileSchema = z.object({
  filename: z.string(),
  name: z.string(),
  type: z.string(),
  markdown: z.string().nullable(),
});
const SWIPE_FRACTION = 1 / 3;
const EDGE_WIDTH = 32;

/**
Show a native file or the exact chat Markdown renderer while retaining the covered parent route.
@param props - Original local path and whether navigation intercepted an existing chat.
@returns Accessible full-screen file surface with native history and deliberate edge swipe-back.
*/
export function FileViewer({ filename, overlay = false }: { filename: string; overlay?: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [file, setFile] = useState<z.infer<typeof fileSchema> | null>(null);
  const [error, setError] = useState("");
  const back = () => {
    if (overlay) {
      router.back();
    } else {
      router.push("/");
    }
  };
  const url = `/api/files?path=${encodeURIComponent(filename)}`;

  useEffect(() => {
    const controller = new AbortController();

    void fetch(`${url}&metadata=1`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("File is unavailable.");
        }
        setFile(fileSchema.parse(await response.json()));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "File is unavailable.");
        }
      });
    return () => {
      controller.abort();
    };
  }, [url]);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="file-viewer"
      aria-label={file?.name ?? "File"}
      style={{ transform: `translateX(${String(offset)}px)` }}
      onCancel={(event) => {
        event.preventDefault();
        back();
      }}
      onPointerDown={(event) => {
        if (event.clientX <= EDGE_WIDTH && !window.getSelection()?.toString()) {
          drag.current = { x: event.clientX, y: event.clientY };
        }
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) {
          return;
        }
        const x = event.clientX - start.x;
        if (Math.abs(event.clientY - start.y) > Math.max(EDGE_WIDTH, x)) {
          drag.current = null;
          setOffset(0);
          return;
        }
        setOffset(Math.max(0, x));
      }}
      onPointerUp={() => {
        drag.current = null;
        if (offset >= window.innerWidth * SWIPE_FRACTION) {
          back();
        }
        setOffset(0);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setOffset(0);
      }}
    >
      <header className="file-viewer-header">
        <Button variant="ghost" size="icon-xl" aria-label="Back to chat" onClick={back}>
          <ArrowLeftIcon />
        </Button>
        <h1 title={file?.name}>{file?.name ?? filename.split("/").at(-1)}</h1>
      </header>
      <div className="file-viewer-content">
        {error ? (
          <p role="alert">{error}</p>
        ) : file?.markdown !== null && file?.markdown !== undefined ? (
          <Markdown allowCopyActions fileBase={file.filename}>
            {file.markdown}
          </Markdown>
        ) : file ? (
          <iframe title={file.name} src={url} sandbox="allow-same-origin allow-downloads" />
        ) : (
          <p role="status">Loading…</p>
        )}
      </div>
    </dialog>
  );
}
