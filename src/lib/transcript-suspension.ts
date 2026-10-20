import { type Virtualizer, elementScroll } from "@tanstack/react-virtual";
import type { ScrollSnapshot } from "./transcript-virtualization";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
const STABLE_FRAMES = 2;
const MAX_RESTORE_FRAMES = 30;

// Keep observers and measured sizes alive. Disabling a virtualizer discards
// state; freezing only scroll writes allows background data to reconcile.
export class TranscriptSuspension {
  private paused = false;
  private cached = false;
  private restoring = false;
  private writing = false;
  private offset = 0;
  private extent = 0;
  private frame = 0;
  private dirty = false;
  private flushing = false;
  private measurements = new Set<() => boolean>();
  private instance?: TranscriptVirtualizer;

  constructor(private readonly changed: () => void) {}

  private reveal(instance: TranscriptVirtualizer) {
    if (!this.restoring || !this.cached || (instance.scrollElement?.clientHeight ?? 0) === 0) {
      return;
    }

    // Restore before the revealed parent can paint at native offset zero.
    this.writing = true;
    instance.scrollToOffset(this.offset, { behavior: "auto" });
    this.writing = false;
    this.cached = false;
    this.changed();
  }

  get blocked() {
    return this.paused || this.restoring;
  }

  shouldCacheMeasurements(requested: boolean) {
    return requested || this.cached;
  }

  capture(instance: TranscriptVirtualizer): ScrollSnapshot | null {
    const element = instance.scrollElement;

    return element && element.clientHeight > 0 ? { offset: element.scrollTop, extent: element.scrollHeight } : null;
  }

  retain(snapshot: ScrollSnapshot) {
    this.offset = snapshot.offset;
    this.extent = Math.max(this.extent, snapshot.extent);
  }

  viewportStyle(requested: boolean) {
    return { overflowAnchor: "none" as const, overflowY: requested ? ("hidden" as const) : undefined };
  }

  addMeasurement(measure: () => boolean) {
    this.measurements.add(measure);

    return () => {
      this.measurements.delete(measure);
    };
  }

  flushMeasurements() {
    if (!this.dirty || this.flushing) {
      return !this.dirty;
    }

    this.flushing = true;

    try {
      this.dirty = ![...this.measurements].map((measure) => measure()).every(Boolean);
    } finally {
      this.flushing = false;
    }

    return !this.dirty;
  }

  finish(pauseMotion: (value: boolean, offset?: number) => void) {
    if (this.paused || !this.restoring) {
      return;
    }

    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.restoring = false;
    this.cached = false;
    this.instance?.cancelScroll();
    pauseMotion(false);
    this.changed();
  }

  readPosition(instance: TranscriptVirtualizer, requested: boolean) {
    if (!requested && !this.blocked) {
      this.offset = instance.scrollOffset ?? this.offset;
    }
  }

  size(total: number, requested: boolean, height: number, element: HTMLElement | null) {
    if (requested || this.blocked) {
      return Math.max(total, this.extent, element?.scrollHeight ?? 0, this.offset + height);
    }

    this.extent = total;

    return 0;
  }

  scrollTo(
    offset: number,
    options: { adjustments?: number; behavior?: "auto" | "smooth" | "instant" },
    instance: TranscriptVirtualizer,
    requested: boolean,
    otherwise: () => void
  ) {
    if (this.writing) {
      elementScroll(offset, { ...options, behavior: "instant" }, instance);
    } else if (!requested && !this.blocked) {
      otherwise();
    }
  }

  update(requested: boolean, instance: TranscriptVirtualizer, pauseMotion: (value: boolean, offset?: number) => void) {
    if (requested === this.paused) {
      this.reveal(instance);

      return;
    }

    cancelAnimationFrame(this.frame);
    this.instance = instance;
    this.paused = requested;
    this.restoring = !requested;
    pauseMotion(true, this.offset);
    instance.cancelScroll();

    if (requested) {
      this.cached = true;
      this.dirty = true;

      return;
    }

    this.reveal(instance);
    let previous = instance.getTotalSize();
    let stable = 0;
    let frames = 0;
    const restore = () => {
      // Returning renders before an ancestor's display:none mutation is undone.
      // Keep sizes cached until visible, then let both lists commit that option.
      if (this.cached || instance.options.useCachedMeasurements) {
        this.reveal(instance);

        this.frame = requestAnimationFrame(restore);

        return;
      }

      if (frames === 0 || Math.abs((instance.scrollElement?.scrollTop ?? 0) - this.offset) >= 1) {
        this.writing = true;
        instance.scrollToOffset(this.offset, { behavior: "auto" });
        this.writing = false;
      }

      const measured = this.flushMeasurements();
      const total = instance.getTotalSize();
      stable = Math.abs(total - previous) < 1 ? stable + 1 : 0;
      previous = total;
      frames += 1;

      const reached = Math.abs((instance.scrollElement?.scrollTop ?? 0) - this.offset) < 1;

      if ((reached && measured && stable >= STABLE_FRAMES) || frames >= MAX_RESTORE_FRAMES) {
        if (!reached) {
          elementScroll(this.offset, { behavior: "instant" }, instance);
        }

        this.finish(pauseMotion);
      } else {
        this.frame = requestAnimationFrame(restore);
      }
    };
    this.frame = requestAnimationFrame(restore);
  }

  unmount() {
    cancelAnimationFrame(this.frame);
  }
}
