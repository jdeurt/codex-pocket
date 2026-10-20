import { ACTIVITY_MOTION } from "./activity-motion";

// The single scroll owner's existing eased clock; retargeting keeps its time.
export class TranscriptScrollAnimation {
  private clock = new Animation(new KeyframeEffect(null, [], { ...ACTIVITY_MOTION, fill: "both" }));
  private start = performance.now();
  private base = 0;
  private frame = 0;
  private stopped = true;

  constructor(
    private from: number,
    private target: number
  ) {}

  retarget(target: number, position: number) {
    if (this.target === target) {
      return;
    }

    this.clock.currentTime = Math.min(performance.now() - this.start, ACTIVITY_MOTION.duration);
    this.base = this.clock.effect?.getComputedTiming().progress ?? 0;
    this.from = position;
    this.target = target;
  }

  step(reduced: boolean) {
    const elapsed = reduced
      ? ACTIVITY_MOTION.duration
      : Math.min(performance.now() - this.start, ACTIVITY_MOTION.duration);
    this.clock.currentTime = elapsed;
    const eased = this.clock.effect?.getComputedTiming().progress ?? 1;
    const progress = this.base >= 1 ? 1 : Math.max(0, (eased - this.base) / (1 - this.base));

    return { offset: this.from + (this.target - this.from) * progress, finished: elapsed >= ACTIVITY_MOTION.duration };
  }

  cancel() {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.clock.cancel();
  }

  run(reduced: () => boolean, write: (offset: number, finished: boolean) => void) {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) {
        return;
      }

      const { offset, finished } = this.step(reduced());
      write(offset, finished);

      if (this.stopped) {
        return;
      }

      if (finished) {
        this.cancel();
      } else {
        this.frame = requestAnimationFrame(tick);
      }
    };
    this.frame = requestAnimationFrame(tick);
  }
}
