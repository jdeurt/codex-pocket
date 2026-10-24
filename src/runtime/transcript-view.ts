import { type RefObject, type UIEvent } from "react";
import { elementScroll, measureElement, type Virtualizer } from "@tanstack/react-virtual";
import { END_THRESHOLD } from "../lib/transcript-virtualization";
import { subscribeTranscriptBookmark } from "./transcript-bookmark";

type Instance = Virtualizer<HTMLDivElement, HTMLElement>;

/** Read a mounted scroll element only when the native virtualizer requests it.
@param viewport - Ref whose node is owned by React.
@returns Current scroll element.
*/
export function transcriptViewport(viewport: RefObject<HTMLDivElement | null>) {
  return viewport.current;
}

/** Read fractional native geometry unless suspended cached measurements are active.
@param element - Mounted transcript row.
@param entry - Optional resize-observer measurement.
@param instance - Native measurement owner.
@returns Current row height.
*/
export const measureTranscriptRow: NonNullable<Instance["options"]["measureElement"]> = (element, entry, instance) =>
  instance.options.useCachedMeasurements
    ? measureElement(element, entry, instance)
    : (entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height);

/** Apply native scroll requests only while the parent is uncovered.
@param isSuspended - Whether a child view covers this transcript.
@param offset - Native requested offset.
@param options - Native adjustment and behavior.
@param instance - Scroll owner.
*/
export function scrollTranscript(
  isSuspended: boolean,
  offset: Parameters<Instance["options"]["scrollToFn"]>[0],
  options: Parameters<Instance["options"]["scrollToFn"]>[1],
  instance: Instance
) {
  if (!isSuspended) {
    elementScroll(offset, options, instance);
  }
}

/** Reattach measurement refs only while the parent is visible.
@param instance - Native measurement owner.
@param isSuspended - Whether cached geometry is frozen.
@param element - Mounted row or null on removal.
*/
export function attachTranscriptRow(instance: Instance, isSuspended: boolean, element: HTMLElement | null) {
  if (!isSuspended) {
    instance.measureElement(element);
  }
}

/** Let user input resume native following without overriding a covered parent.
@param isSuspended - Covered-parent state.
@param initialEnd - Mutable lifecycle marker for initial positioning.
@param publish - Component-local follow setter.
*/
export function resumeTranscriptFollow(
  isSuspended: boolean,
  initialEnd: RefObject<boolean>,
  publish: (shouldFollow: boolean) => void
) {
  if (isSuspended) {
    return;
  }

  initialEnd.current = false;
  publish(true);
}

/** Keep initial end positioning after late footer and viewport measurements.
@param instance - Native scroll owner.
@param initialEnd - Whether initial positioning still owns the view.
@param isSuspended - Covered-parent state.
*/
export function maintainTranscriptEnd(instance: Instance, initialEnd: RefObject<boolean>, isSuspended: boolean) {
  if (!isSuspended && initialEnd.current) {
    instance.scrollToEnd();
  }
}

/** Retain a parent's native offset while a child view covers it.
@param instance - Native scroll owner.
@param viewport - Mounted scrolling element.
@param saved - Offset owned by this suspension lifetime.
@param isSuspended - Current covered-parent state.
*/
export function preserveTranscriptOffset(
  instance: Instance,
  viewport: RefObject<HTMLDivElement | null>,
  saved: RefObject<number | undefined>,
  isSuspended: boolean
) {
  if (isSuspended) {
    saved.current = viewport.current?.scrollTop;
    instance.cancelScroll();
  } else if (saved.current !== undefined) {
    instance.scrollToOffset(saved.current);
    saved.current = undefined;
  }
}

/** Observe departure only for a parent with durable reading-position identity.
@param key - Native parent identity, absent for child previews.
@param instance - Native measurement owner.
@param expanded - Disclosures corresponding to current measurements.
@returns Page-lifecycle cleanup, or undefined for a transient child.
*/
export function connectTranscriptBookmark(key: string | undefined, instance: Instance, expanded: Set<string>) {
  return key ? subscribeTranscriptBookmark(key, instance, expanded) : undefined;
}

/** Relinquish initial end positioning once the user scrolls away.
@param initialEnd - Initial-position lifecycle marker.
@param event - Native viewport scroll.
*/
export function trackTranscriptScroll(initialEnd: RefObject<boolean>, event: UIEvent<HTMLDivElement>) {
  const target = event.currentTarget;

  initialEnd.current &&= target.scrollTop + target.clientHeight >= target.scrollHeight - END_THRESHOLD;
}

/** Request native following and move to the latest rendered message.
@param publish - Component-local follow setter.
@param instance - Native scroll owner.
*/
export function jumpToLatest(publish: (shouldFollow: boolean) => void, instance: Instance) {
  publish(true);
  instance.scrollToEnd();
}
