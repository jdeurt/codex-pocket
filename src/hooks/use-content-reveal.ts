"use client";
import { useEffect, useRef } from "react";

const revealed = new Set<string>();
const MAX_REVEALS = 4096;
const DURATION_MS = 100;

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
    const animations = [...(ref.current?.querySelectorAll("[data-pocket-fresh]") ?? [])].map((node) =>
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS, easing: "ease-out" })
    );
    return () => {
      for (const animation of animations) {
        animation.cancel();
      }
    };
  }, [revision]);

  return ref;
}
