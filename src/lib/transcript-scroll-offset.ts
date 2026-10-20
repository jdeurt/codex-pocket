import { type Virtualizer, elementScroll, observeElementOffset } from "@tanstack/react-virtual";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
type OffsetObserver = (offset: number, scrolling: boolean) => void;

// Keep the normal native observers. An intentional seek can report its actual
// read-back immediately so both lists render that range before the next paint.
export class TranscriptScrollOffset {
  private observers = new Set<OffsetObserver>();
  private frozen?: number;

  observe = (instance: TranscriptVirtualizer, callback: OffsetObserver) => {
    this.observers.add(callback);
    const stop = observeElementOffset(instance, (offset, scrolling) =>
      callback(this.frozen ?? offset, this.frozen === undefined && scrolling)
    );

    if (this.frozen !== undefined) {
      callback(this.frozen, false);
    }

    return () => {
      this.observers.delete(callback);
      stop?.();
    };
  };

  freeze(offset: number | undefined, instance?: TranscriptVirtualizer) {
    this.frozen = offset;
    const position = offset ?? instance?.scrollElement?.scrollTop;

    if (position !== undefined) {
      for (const callback of this.observers) {
        callback(position, false);
      }
    }
  }

  write(offset: number, instance: TranscriptVirtualizer, eager: boolean) {
    elementScroll(offset, { behavior: "instant" }, instance);

    if (eager && instance.scrollElement) {
      for (const callback of this.observers) {
        callback(instance.scrollElement.scrollTop, true);
      }
    }
  }
}
