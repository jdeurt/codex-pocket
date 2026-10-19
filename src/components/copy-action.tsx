"use client";
import { Button } from "@/components/ui/button";
import { CopyIcon } from "lucide-react";
import { useState } from "react";

export function CopyAction({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  async function copy() {
    setStatus("copying");

    try {
      if (!globalThis.navigator.clipboard?.writeText) {
        throw new Error("Clipboard is unavailable.");
      }

      // Invoke in the click handler, before any await, to retain user activation.
      await globalThis.navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="copy-action">
      <Button type="button" variant="outline" size="touch" disabled={status === "copying"} onClick={copy}>
        <CopyIcon aria-hidden="true" />
        Copy text
      </Button>
      <span className="copy-action-status" role="status" aria-live="polite" aria-atomic="true">
        {status === "copied"
          ? "Copied"
          : status === "error"
            ? "Couldn’t copy. Check browser clipboard access and try again."
            : status === "copying"
              ? "Copying…"
              : ""}
      </span>
    </div>
  );
}
