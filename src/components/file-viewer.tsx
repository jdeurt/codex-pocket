"use client";
import "./file-viewer.css";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Markdown } from "./markdown";
import { pocketUrl } from "@/lib/pockets";
import { useRouter } from "next/navigation";
import { z } from "zod";

const fileSchema = z.object({
  filename: z.string(),
  name: z.string(),
  type: z.string(),
  markdown: z.string().nullable(),
});
const SWIPE_DIVISOR = 3;
const LAST_COMPONENT = -1;
const EDGE_WIDTH = 32;

/**
Render loaded Markdown with chat semantics or let the browser handle a native file.
@param props - Validated file metadata, load error and same-origin content URL.
@returns Content appropriate to the current loading state.
*/
function FileContent({ file, error, url }: { file: z.infer<typeof fileSchema> | null; error: string; url: string }) {
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
      router.push(pocketUrl("/"));
    }
  };
  const url = pocketUrl(`/api/files?path=${encodeURIComponent(filename)}`);

  function movePointer(event: React.PointerEvent<HTMLDialogElement>, start: { x: number; y: number }) {
    const x = event.clientX - start.x;

    if (Math.abs(event.clientY - start.y) > Math.max(EDGE_WIDTH, x)) {
      drag.current = null;
      setOffset(0);

      return;
    }

    setOffset(Math.max(0, x));

    if (x > EDGE_WIDTH) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  useEffect(() => {
    const controller = new AbortController();

    void fetch(`${url}&metadata=1`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("File is unavailable.");
        }

        setFile(fileSchema.parse(await response.json()));
      })
      .catch((error_: unknown) => {
        if (!controller.signal.aborted) {
          setError(error_ instanceof Error ? error_.message : "File is unavailable.");
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
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.classList.contains("file-viewer-edge") ||
          globalThis.getSelection()?.toString()
        ) {
          return;
        }

        event.preventDefault();
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;

        if (!start) {
          return;
        }

        movePointer(event, start);
      }}
      onPointerUp={() => {
        drag.current = null;

        if (offset >= window.innerWidth / SWIPE_DIVISOR) {
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
        <h1 title={file?.name}>{file?.name ?? filename.split("/").at(LAST_COMPONENT)}</h1>
      </header>
      <div className="file-viewer-edge" aria-hidden="true" />
      <div className="file-viewer-content">
        <FileContent file={file} error={error} url={url} />
      </div>
    </dialog>
  );
}
