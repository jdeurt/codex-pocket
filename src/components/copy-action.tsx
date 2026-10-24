"use client";
import { Button } from "@/components/ui/button";
import { CopyIcon } from "lucide-react";
import { useState } from "react";

const copyLabels = {
  idle: "",
  copied: "Copied",
  copying: "Copying…",
  error: "Couldn’t copy. Check browser clipboard access and try again.",
};

/**
Copy only the exact validated payload from an explicit user gesture.
@param props - Exact copy text, without trimming or newline conversion.
@returns The copy button and its accessible pending/success/failure status.
*/
export function CopyAction({ text }: { text: string }) {
  const [status, setStatus] = useState<keyof typeof copyLabels>("idle");

  async function copy() {
    setStatus("copying");

    if (!("clipboard" in navigator)) {
      setStatus("error");

      return;
    }

    await (async () => {
      // Invoke in the click handler, before any await, to retain user activation.
      await globalThis.navigator.clipboard.writeText(text);
      setStatus("copied");
    })().catch(() => {
      setStatus("error");
    });
  }

  return (
    <div className="copy-action">
      <Button
        type="button"
        variant="outline"
        size="touch"
        disabled={status === "copying"}
        onClick={() => {
          void copy();
        }}
      >
        <CopyIcon aria-hidden="true" />
        Copy text
      </Button>
      <span className="copy-action-status" role="status" aria-live="polite" aria-atomic="true">
        {copyLabels[status]}
      </span>
    </div>
  );
}
