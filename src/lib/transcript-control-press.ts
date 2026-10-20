// Cancel motion immediately, but keep its scroll extent through the browser's
// pointerup -> click activation task so a pressed control cannot move away.
export class TranscriptControlPress {
  private events?: AbortController;
  private frame = 0;
  active = false;
  retained = false; // An interrupted snapshot may extend beyond the new logical end.

  constructor(private readonly complete: () => void) {}

  begin(retain: boolean) {
    this.cancel();
    this.active = true;
    this.retained = retain;
    const events = new AbortController();
    this.events = events;
    const finish = () => {
      events.abort();
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.active = false;
        this.complete();
      });
    };

    for (const type of ["pointerup", "pointercancel", "touchend", "touchcancel"]) {
      globalThis.addEventListener(type, finish, { capture: true, once: true, signal: events.signal });
    }

    // Element focus changes dispatch capturing blur too; only window blur ends
    // an otherwise unfinished press.
    globalThis.addEventListener("blur", finish, { once: true, signal: events.signal });
  }

  cancel() {
    this.events?.abort();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.active = false;
    this.retained = false;
  }
}
