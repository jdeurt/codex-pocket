import { type RefObject } from "react";

const MAX_REVEALS = 4096;
const DURATION_MS = 100;

/** Cancel only animations started by this mounted revision.
@param animations - Native handles owned by the effect.
*/
function cancelAnimations(animations: Animation[]) {
  for (const animation of animations) {
    animation.cancel();
  }
}

/** Start one native opacity animation for a newly revealed span.
@param node - Mounted element identified by the rendering annotation.
@returns Native handle owned by the current revision.
*/
function animateNode(node: Element) {
  return node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION_MS, easing: "ease-out" });
}

/**
Own replay suppression per Pocket and animation handles per mounted revision.
*/
export class ContentReveals {
  private readonly seen = new Set<string>();

  /** Animate the current revision after mount without queuing older speech or text.
  @param ref - Mounted Markdown container.
  @param revision - Source-change identity, absent for loaded history.
  @returns Cleanup for this revision's native animations.
  */
  connect = (ref: RefObject<HTMLDivElement | null>, revision?: string) => {
    if (!revision || this.seen.has(revision)) {
      return;
    }

    this.seen.add(revision);

    if (this.seen.size > MAX_REVEALS) {
      const oldest = this.seen.values().next().value;

      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const animations = Array.from(ref.current?.querySelectorAll("[data-pocket-fresh]") ?? [], animateNode);

    return cancelAnimations.bind(undefined, animations);
  };
}
