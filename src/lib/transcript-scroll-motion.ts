import { type Virtualizer, elementScroll } from "@tanstack/react-virtual";
import { isAtTranscriptEnd, needsTranscriptSeek } from "./transcript-virtualization";
import { ACTIVITY_MOTION } from "./activity-motion";
import { TranscriptScrollOffset } from "./transcript-scroll-offset";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
const STABLE_FRAMES = 2;

export class TranscriptScrollMotion {
  private seeking = false;
  private following = true;
  private allowFollow = true;
  private ready = false;
  private instance?: TranscriptVirtualizer;
  private canvas?: HTMLDivElement;
  private frame = 0;
  private settling = 0;
  private inputFrame = 0;
  private heldSize = 0;
  private previousSize = 0;
  private anchored = false;
  private lastSource?: { id: string; text: string };
  private streamingUntil = 0;
  private outgoing?: string;
  private suspended = false;
  private correcting = false;
  private intent = false;
  private disclosure = false;
  private seeked = false;
  private animation?: { from: number; target: number; start: number; base: number; clock: Animation };
  readonly offsets = new TranscriptScrollOffset();
  private element() {
    return this.instance?.scrollElement;
  }
  private reduced() {
    return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  private target() {
    return Math.max((this.instance?.getTotalSize() ?? 0) - (this.element()?.clientHeight ?? 0), 0);
  }
  private phase(value: string) {
    const element = this.element();

    if (element) {
      element.dataset.scrollMotion = value;
    }
  }

  private release() {
    this.heldSize = 0;

    if (this.canvas && !this.suspended) {
      this.canvas.style.minHeight = "0px";
    }
  }
  private correct(smooth: boolean) {
    const instance = this.instance;
    const element = this.element();

    if (!instance || !element || !this.following) {
      return;
    }

    const target = this.target();

    if (smooth && !this.reduced() && !this.seeked && needsTranscriptSeek(instance, this.canvas)) {
      this.seeked = true;
      this.seeking = true;
      instance.scrollToOffset(
        Math.max(target + (Math.sign(element.scrollTop - target) * element.clientHeight) / 2, 0),
        { behavior: "auto" }
      );
      this.seeking = false;
      this.layout();

      return;
    }

    if (Math.abs(target - element.scrollTop) < 1) {
      this.release();
      this.phase("idle");
      this.intent = false;
      this.seeked = false;

      return;
    }

    this.correcting = true;
    instance.scrollToEnd({ behavior: smooth && !this.reduced() ? "smooth" : "auto" });
    this.correcting = false;

    if (smooth && !this.reduced()) {
      return;
    }

    this.release();
    this.phase("idle");
    this.intent = false;
    instance.cancelScroll();
  }
  size(total: number) {
    if (
      this.disclosure &&
      this.ready &&
      total - (this.element()?.clientHeight ?? 0) < (this.element()?.scrollTop ?? 0)
    ) {
      this.following = true;
      this.intent = true;
    }

    if (this.ready && this.following && !this.suspended && !this.anchored && total < this.previousSize) {
      this.heldSize = Math.max(this.heldSize, this.previousSize);
    }

    this.previousSize = total;
    this.anchored = false;

    return this.heldSize;
  }
  mount(instance: TranscriptVirtualizer, canvas: HTMLDivElement) {
    this.instance = instance;
    this.canvas = canvas;
    instance.scrollToEnd({ behavior: "auto" });
    this.settling = requestAnimationFrame(() => {
      this.settling = requestAnimationFrame(() => {
        this.settling = 0;
        this.ready = true;
        this.layout();
      });
    });
  }
  source(id: string, text: string) {
    if (this.lastSource?.id === id && this.lastSource.text !== text) {
      this.streamingUntil = performance.now() + ACTIVITY_MOTION.duration;
    }

    this.lastSource = { id, text };
  }
  readPosition(instance: TranscriptVirtualizer, sync: boolean) {
    if (sync && this.allowFollow && !this.suspended && !this.inputFrame && isAtTranscriptEnd(instance)) {
      this.following = true;
    }
  }
  cancel(preserveExtent = false) {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.settling);
    cancelAnimationFrame(this.inputFrame);
    this.frame = 0;
    this.settling = 0;
    this.inputFrame = 0;
    this.animation?.clock.cancel();
    this.animation = undefined;
    this.intent = false;
    this.disclosure = false;
    this.seeked = false;
    this.instance?.cancelScroll();

    if (!preserveExtent) {
      this.release();
    }

    this.phase("idle");
  }
  interrupt() {
    this.allowFollow = true;
    this.cancel();
    this.following = false;
    this.inputFrame = requestAnimationFrame(() => {
      this.inputFrame = requestAnimationFrame(() => {
        this.inputFrame = 0;
        this.following = isAtTranscriptEnd(this.instance);
      });
    });
  }

  control() {
    this.allowFollow = true;
    const pinned = isAtTranscriptEnd(this.instance);
    this.cancel();
    this.following = pinned;
  }
  scrollTo(
    offset: number,
    options: { adjustments?: number; behavior?: "auto" | "smooth" | "instant" },
    instance: TranscriptVirtualizer
  ) {
    const target =
      (this.animation || this.correcting) && this.following ? this.target() : offset + (options.adjustments ?? 0);

    if (this.animation) {
      if (this.animation.target !== target) {
        this.animation.clock.currentTime = Math.min(performance.now() - this.animation.start, ACTIVITY_MOTION.duration);
        this.animation.base = this.animation.clock.effect?.getComputedTiming().progress ?? 0;
        this.animation.from = instance.scrollElement?.scrollTop ?? this.animation.from;
        this.animation.target = target;
      }

      return;
    }

    if (options.behavior !== "smooth" || this.reduced() || !this.ready) {
      this.anchored = !this.correcting && options.adjustments !== undefined;
      this.offsets.write(target, instance, this.seeking);

      return;
    }

    const element = instance.scrollElement;

    if (!element || Math.abs(target - element.scrollTop) < 1) {
      return;
    }

    const clock = new Animation(new KeyframeEffect(null, [], { ...ACTIVITY_MOTION, fill: "both" }));
    this.animation = { from: element.scrollTop, target, start: performance.now(), base: 0, clock };
    this.phase("smooth");
    const tick = () => {
      const current = this.animation;

      if (!current) {
        return;
      }

      const elapsed = this.reduced()
        ? ACTIVITY_MOTION.duration
        : Math.min(performance.now() - current.start, ACTIVITY_MOTION.duration);
      current.clock.currentTime = elapsed;
      const eased = current.clock.effect?.getComputedTiming().progress ?? 1;
      const progress = current.base >= 1 ? 1 : Math.max(0, (eased - current.base) / (1 - current.base));
      elementScroll(current.from + (current.target - current.from) * progress, { behavior: "instant" }, instance);

      if (elapsed < ACTIVITY_MOTION.duration) {
        this.frame = requestAnimationFrame(tick);
      } else {
        current.clock.cancel();
        this.animation = undefined;
        this.intent = false;
        this.seeked = false;
        this.frame = 0;
        this.release();
        this.phase("idle");
      }
    };
    this.frame = requestAnimationFrame(tick);
  }

  layout() {
    const outgoing = this.canvas?.querySelector<HTMLElement>('[data-delivery="sending"]')?.dataset.messageId;

    if (!this.ready || this.suspended) {
      this.outgoing = outgoing;

      return;
    }

    if (outgoing && outgoing !== this.outgoing) {
      this.following = true;
      this.streamingUntil = 0;
      this.intent = true;
    }

    this.outgoing = outgoing;

    if (!this.following) {
      return;
    }

    if (!this.intent && Math.abs(this.target() - (this.element()?.scrollTop ?? 0)) < 1) {
      this.release();

      if (!this.animation) {
        this.phase("idle");
      }

      return;
    }

    if (this.animation) {
      this.correct(true);

      return;
    }

    if (!this.intent && performance.now() < this.streamingUntil) {
      this.correct(false);

      return;
    }

    if (this.settling) {
      return;
    }

    let last = this.target();
    let stable = 0;
    this.phase("settling");
    const settle = () => {
      if (!this.following) {
        return;
      }

      const next = this.target();
      stable = next === last ? stable + 1 : 0;
      last = next;

      if (stable >= STABLE_FRAMES) {
        this.settling = 0;
        this.correct(true);
      } else {
        this.settling = requestAnimationFrame(settle);
      }
    };
    this.settling = requestAnimationFrame(settle);
  }
  disclose(pinned: boolean) {
    this.cancel(true);
    this.following = pinned || this.following;
    this.intent = this.following;
    this.disclosure = true;
  }

  disclosed() {
    this.disclosure = false;
  }
  latest() {
    this.allowFollow = true;
    this.cancel(true);
    this.following = true;
    this.intent = true;
    this.correct(true);
  }
  suspend(value: boolean, offset?: number) {
    if (value !== this.suspended) {
      this.suspended = value;
      this.allowFollow = false;
      this.cancel();
      this.following = false;
    }

    this.offsets.freeze(value ? offset : undefined, this.instance);
  }
  unmount() {
    this.cancel();
    this.ready = false;
    this.instance = undefined;
    this.canvas = undefined;
  }
}
