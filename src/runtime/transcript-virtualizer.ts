import {
  Virtualizer,
  type VirtualizerOptions,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/react-virtual";
import {
  type TranscriptLayout,
  initialTranscriptLayout,
  copiedVirtualItem,
  hasSameLayout,
  shouldFollowViewport,
  restoredAnchor,
  shouldAdjustRestoredAnchor,
} from "../state/transcript-layout";

export type MessageVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
export type MessageOptions = Omit<
  VirtualizerOptions<HTMLDivElement, HTMLElement>,
  "observeElementOffset" | "observeElementRect" | "scrollToFn"
> & { scrollToFn?: VirtualizerOptions<HTMLDivElement, HTMLElement>["scrollToFn"] };

type NativeRect = Parameters<Parameters<MessageVirtualizer["options"]["observeElementRect"]>[1]>[0];

/** Apply the pure follow decision around the native viewport update.
@param instance - Native measurement and scroll owner.
@param onRect - Native geometry consumer.
@param rect - Incoming viewport geometry.
*/
function adoptRect(instance: MessageVirtualizer, onRect: (rect: NativeRect) => void, rect: NativeRect) {
  const shouldFollow = shouldFollowViewport({
    anchorTo: instance.options.anchorTo,
    followOnAppend: Boolean(instance.options.followOnAppend),
    previousHeight: instance.scrollRect?.height,
    nextHeight: rect.height,
    size: instance.getTotalSize(),
    offset: instance.scrollOffset ?? 0,
    threshold: instance.options.scrollEndThreshold,
    scale: instance.targetWindow?.visualViewport?.scale ?? 1,
  });

  onRect(rect);

  if (shouldFollow) {
    instance.scrollToEnd();
  }
}

/** Bind explicit ownership to the native geometry observer.
@param instance - Native measurement owner.
@param onRect - Native callback accepting new geometry.
@returns Cleanup for this observer.
*/
const observeTranscriptRect: MessageVirtualizer["options"]["observeElementRect"] = (instance, onRect) =>
  observeElementRect(instance, adoptRect.bind(undefined, instance, onRect));

/** Copy native measurements into a detached React snapshot.
@param instance - Native owner of layout and scrolling.
@returns Immutable-by-ownership layout values.
*/
function readLayout(instance: MessageVirtualizer): TranscriptLayout {
  return {
    rows: Array.from(instance.getVirtualItems(), copiedVirtualItem),
    size: instance.getTotalSize(),
    offset: instance.scrollOffset ?? 0,
    height: instance.scrollRect?.height ?? 0,
    atEnd: instance.isAtEnd(),
  };
}

/**
Own native measurement lifecycle and publish detached values to React.
*/
export class TranscriptVirtualizer {
  private readonly listeners = new Set<() => void>();
  private layout = initialTranscriptLayout();
  private readonly instance: MessageVirtualizer;

  /** Release a mounted React observer.
  @param listener - Exact callback registered by the observer.
  */
  private unsubscribe = (listener: () => void) => {
    this.listeners.delete(listener);
  };

  /** Publish native changes before forwarding the caller's configured lifecycle callback.
  @param onChange - Caller-supplied native callback, if present.
  @param instance - Native measurement owner.
  @param isSynchronous - Native synchronous-update flag.
  */
  private changed = (onChange: MessageOptions["onChange"], instance: MessageVirtualizer, isSynchronous: boolean) => {
    this.publish(instance);
    onChange?.(instance, isSynchronous);
  };

  /** Return the stable detached snapshot consumed by React.
  @returns Latest cached geometry.
  */
  getSnapshot = () => this.layout;

  /** Register a React observer without exposing mutable native items.
  @param listener - React's external-store notification.
  @returns Cleanup for exactly this subscription.
  */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return this.unsubscribe.bind(undefined, listener);
  };

  /** Attach native observers after mount.
  @returns Native observer cleanup.
  */
  mount = () => this.instance._didMount();

  /** Commit the matching rendered geometry before native anchor/follow adjustments.
  @param rendered - Snapshot just committed by React.
  */
  commit = (rendered: TranscriptLayout) => {
    if (this.layout !== rendered) {
      return;
    }

    this.instance._willUpdate();
    this.publish(this.instance);
  };

  /** Construct native resources without mounting observers.
  @param options - Initial native options.
  */
  constructor(options: MessageOptions) {
    this.instance = new Virtualizer({
      observeElementOffset,
      observeElementRect: observeTranscriptRect,
      scrollToFn: elementScroll,
      ...options,
      onChange: this.changed.bind(undefined, options.onChange),
    });
    this.layout = readLayout(this.instance);
  }

  /** Retain the previous value when native geometry has not changed.
  @param instance - Native measurement owner.
  */
  private cacheLayout(instance: MessageVirtualizer) {
    const next = readLayout(instance);

    if (!hasSameLayout(this.layout, next)) {
      this.layout = next;
    }
  }

  /** Notify subscribers only when their detached snapshot changes.
  @param instance - Native measurement owner.
  */
  private publish(instance: MessageVirtualizer) {
    const previous = this.layout;

    this.cacheLayout(instance);

    if (previous !== this.layout) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  /** Configure before DOM commit so native following can inspect the previous extent.
  @param options - Current native options.
  @param adjust - Caller-provided size-adjustment decision, if present.
  @returns Native virtualizer used for rendering bindings.
  */
  configure(options: MessageOptions, adjust?: MessageVirtualizer["shouldAdjustScrollPositionOnItemSizeChange"]) {
    this.instance.setOptions({
      observeElementOffset,
      observeElementRect: observeTranscriptRect,
      scrollToFn: elementScroll,
      ...options,
      onChange: this.changed.bind(undefined, options.onChange),
    });
    const offset = typeof options.initialOffset === "function" ? options.initialOffset() : (options.initialOffset ?? 0);
    const anchor = restoredAnchor(options.initialMeasurementsCache, offset);
    const isRestoring = anchor !== undefined && options.anchorTo === "start" && !options.useCachedMeasurements;

    this.instance.shouldAdjustScrollPositionOnItemSizeChange =
      adjust ?? (isRestoring ? shouldAdjustRestoredAnchor.bind(undefined, anchor) : undefined);
    this.cacheLayout(this.instance);

    return this.instance;
  }
}
