import { type RefObject } from "react";
import { type VirtualItem } from "@tanstack/react-virtual";
import { type MessageVirtualizer } from "./transcript-virtualizer";
import { shouldAdjustActivity } from "../state/transcript-layout";

export type ActivityMeasurements = Map<string, VirtualItem[]>;

/** Read the parent viewport's current offset at native initialization.
@param viewport - Mounted parent viewport ref.
@returns Native offset, or zero before mount.
*/
export function activityInitialOffset(viewport: RefObject<HTMLDivElement | null>) {
  return viewport.current?.scrollTop ?? 0;
}

/** Apply the pure nested-anchor decision to current native geometry.
@param isSuspended - Whether the covered parent freezes measurements.
@param margin - Current nested panel origin.
@param item - Item whose size changed.
@param _delta - Native size delta, unnecessary for this anchor decision.
@param instance - Native measurement owner.
@returns Whether the inner virtualizer should adjust its anchor.
*/
export function shouldAdjustActivityItem(
  isSuspended: boolean,
  margin: number,
  item: VirtualItem,
  _delta: number,
  instance: MessageVirtualizer
) {
  return shouldAdjustActivity(isSuspended, margin, item.end, instance.scrollOffset ?? 0, instance.getTotalSize());
}

/** Publish the nested panel's current native position relative to its parent.
@param content - Mounted panel element.
@param viewport - Mounted parent scroller.
@param isSuspended - Whether covered-parent geometry must remain frozen.
@param publish - Component-local margin setter.
*/
export function measureActivityMargin(
  content: RefObject<HTMLDivElement | null>,
  viewport: RefObject<HTMLDivElement | null>,
  isSuspended: boolean,
  publish: (margin: number) => void
) {
  const element = content.current;
  const scroller = viewport.current;

  if (element && scroller && !isSuspended) {
    publish(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
  }
}

/** Retain native measurements when this nested panel's lifecycle ends.
@param measurements - Parent-owned measurement cache.
@param id - Stable panel identity.
@param instance - Native measurement owner.
*/
function saveActivityMeasurements(measurements: ActivityMeasurements, id: string, instance: MessageVirtualizer) {
  measurements.set(id, instance.takeSnapshot());
}

/** Bind native measurement retention to this panel's mounted lifetime.
@param measurements - Parent-owned cache.
@param id - Panel identity.
@param instance - Native measurement owner.
@returns Cleanup that saves this exact instance's geometry.
*/
export function retainActivityMeasurements(
  measurements: ActivityMeasurements,
  id: string,
  instance: MessageVirtualizer
) {
  return saveActivityMeasurements.bind(undefined, measurements, id, instance);
}
