import { type StoreApi } from "zustand/vanilla";
import { scrolledTranscript, type TranscriptFollow } from "../state/transcript-follow";
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

/** Pause following as soon as the reader interacts with transcript scrolling.
@param isSuspended - Whether a child view covers this transcript.
@param store - Transcript-owned follow state.
*/
export function pauseTranscriptFollow(isSuspended: boolean, store: StoreApi<TranscriptFollow>) {
  if (!isSuspended) {
    store.setState({ isFollowing: false });
  }
}

/** Follow committed content growth while the reader remains at the latest message.
@param instance - Native scroll owner.
@param store - Single source of the reader's follow preference.
@param isSuspended - Whether a child view covers this transcript.
*/
export function maintainTranscriptEnd(instance: Instance, store: StoreApi<TranscriptFollow>, isSuspended: boolean) {
  if (!isSuspended && store.getState().isFollowing) {
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

/** Resume following when the reader reaches the bottom; content growth cannot disable it.
@param store - Transcript-owned follow state.
@param event - Native viewport scroll.
*/
export function trackTranscriptScroll(store: StoreApi<TranscriptFollow>, event: UIEvent<HTMLDivElement>) {
  const target = event.currentTarget;
  const isAtEnd = target.scrollHeight - target.clientHeight - target.scrollTop <= END_THRESHOLD;

  store.setState(scrolledTranscript(store.getState(), isAtEnd));
}

/** Resume following and move to the latest rendered message.
@param store - Transcript-owned follow state.
@param instance - Native scroll owner.
*/
export function jumpToLatest(store: StoreApi<TranscriptFollow>, instance: Instance) {
  store.setState({ isFollowing: true });
  instance.scrollToEnd();
}
