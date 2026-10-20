"use client";
import { type RefObject, useEffect } from "react";

// Safari can resize/pan only the visual viewport when the keyboard opens.
// Keep this local to the focused composer; the transcript owns its scroll offset.
export function useComposerViewport(textarea: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const input = textarea.current;
    const shell = input?.closest<HTMLElement>(".chat-shell");
    const viewport = globalThis.visualViewport;

    if (!input || !shell || !viewport) {
      return;
    }

    let frame: number | undefined;
    const reset = () => {
      shell.style.removeProperty("--composer-viewport-height");
      shell.style.removeProperty("--composer-viewport-top");
    };
    const resize = () => {
      // Let the browser pan normally during pinch zoom, including text selection.
      if (viewport.scale !== 1) {
        reset();

        return;
      }

      shell.style.setProperty("--composer-viewport-height", `${String(viewport.height)}px`);
      shell.style.setProperty("--composer-viewport-top", `${String(viewport.offsetTop)}px`);
    };
    const schedule = () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }

      frame = requestAnimationFrame(() => {
        frame = undefined;
        resize();
      });
    };
    const stop = () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }

      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      reset();
    };
    const start = () => {
      resize();
      // Visual viewport changes do not resize the shell's layout viewport.
      viewport.addEventListener("resize", schedule);
      viewport.addEventListener("scroll", schedule);
    };

    input.addEventListener("focus", start);
    input.addEventListener("blur", stop);

    if (document.activeElement === input) {
      start();
    }

    return () => {
      input.removeEventListener("focus", start);
      input.removeEventListener("blur", stop);
      stop();
    };
  }, [textarea]);
}
