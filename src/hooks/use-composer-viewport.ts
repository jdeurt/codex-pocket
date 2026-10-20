"use client";
import { type RefObject, useEffect } from "react";

/**
Bind visual-viewport updates to one focused composer without touching transcript scrolling.
@param input - Native textarea whose focus owns these listeners.
@param shell - Existing chat shell that receives the two viewport CSS variables.
@param viewport - Browser visual viewport associated with this composer.
@returns Cleanup that removes listeners, cancels pending frames and clears the CSS variables.
*/
function subscribeComposerViewport(input: HTMLTextAreaElement, shell: HTMLElement, viewport: VisualViewport) {
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
}

/**
Keep the focused composer inside Safari's visual viewport while leaving transcript offsets native.
@param textarea - Stable ref to the current composer textarea.
*/
export function useComposerViewport(textarea: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const input = textarea.current;
    const shell = input?.closest<HTMLElement>(".chat-shell");
    const viewport = globalThis.visualViewport;

    if (!input || !shell || !viewport) {
      return;
    }

    return subscribeComposerViewport(input, shell, viewport);
  }, [textarea]);
}
