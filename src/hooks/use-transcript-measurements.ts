import { type RefObject, useLayoutEffect } from "react";
import type { TranscriptSuspension } from "@/lib/transcript-suspension";
import type { Virtualizer } from "@tanstack/react-virtual";

export function useTranscriptMeasurements(
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  suspension: TranscriptSuspension,
  container: RefObject<HTMLElement | null>,
  selector: string
) {
  useLayoutEffect(
    () =>
      suspension.addMeasurement(() => {
        // Synchronous measureElement defers during user scrolling; revisit
        // mounted nodes once idle without clearing any other cached sizes.
        if (instance.isScrolling) {
          return false;
        }

        for (const element of container.current?.querySelectorAll<HTMLElement>(selector) ?? []) {
          instance.measureElement(element);
        }

        return true;
      }),
    [container, instance, selector, suspension]
  );
  // A gesture can end position restoration before idle measurements finish.
  // Continue only the size refresh on the virtualizer's next idle render.
  useLayoutEffect(() => {
    if (!suspension.blocked) {
      suspension.flushMeasurements();
    }
  });
}
