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

      shell.style.setProperty("--composer-viewport-height", `${viewport.height}px`);
      shell.style.setProperty("--composer-viewport-top", `${viewport.offsetTop}px`);
    };
    const stop = () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
      reset();
    };
    const start = () => {
      resize();
      // Visual viewport changes do not resize the shell's layout viewport.
      // eslint-disable-next-line unicorn/prefer-observer-apis -- ResizeObserver cannot observe the visual viewport.
      viewport.addEventListener("resize", resize);
      // eslint-disable-next-line unicorn/prefer-observer-apis -- IntersectionObserver cannot report viewport panning.
      viewport.addEventListener("scroll", resize);
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
