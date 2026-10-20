"use client";
import { useEffect, useRef } from "react";

const revealed = new Set<string>();
const MAX_REVEALS = 4096;
const DURATION_MS = 100;

/**
Start only the current native opacity animations and provide cancellation on the next delta.
@param element - Mounted shared Markdown container.
@returns Cleanup cancelling unfinished animations without a backlog.
*/
function animateContent(element: HTMLDivElement | null) {
  const animations = [...(element?.querySelectorAll("[data-pocket-fresh]") ?? [])].map((node) =>
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS, easing: "ease-out" })
  );

  return () => {
    for (const animation of animations) {
      animation.cancel();
    }
  };
}

/**
Animate each incoming revision once, without replaying on virtual remount or building an animation queue.
@param revision - Optional incoming source-change identity, absent for loaded history.
@returns The shared Markdown container ref used for opacity-only native animations.
*/
export function useContentReveal(revision?: string) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!revision || revealed.has(revision)) {
      return;
    }

    revealed.add(revision);

    if (revealed.size > MAX_REVEALS) {
      const oldest = revealed.values().next().value;

      if (oldest) {
        revealed.delete(oldest);
      }
    }

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    return animateContent(ref.current);
  }, [revision]);

  return ref;
}
