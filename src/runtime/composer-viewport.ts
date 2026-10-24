import { type RefObject } from "react";

/**
Own the focused composer's viewport listeners and animation-frame lifetime.
*/
class ComposerViewport {
  private frame?: number;

  /**
  Clear layout overrides when native panning should resume.
  */
  private reset = () => {
    this.shell.style.removeProperty("--composer-viewport-height");
    this.shell.style.removeProperty("--composer-viewport-top");
  };

  /**
  Read browser geometry and update only the composer's CSS variables.
  */
  private resize = () => {
    this.frame = undefined;

    if (this.viewport.scale !== 1) {
      this.reset();

      return;
    }

    this.shell.style.setProperty("--composer-viewport-height", `${String(this.viewport.height)}px`);
    this.shell.style.setProperty("--composer-viewport-top", `${String(this.viewport.offsetTop)}px`);
  };

  /**
  Coalesce viewport events into the next browser frame.
  */
  private schedule = () => {
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
    }

    this.frame = requestAnimationFrame(this.resize);
  };

  /**
  Release focus-scoped resources and clear viewport overrides.
  */
  private blur = () => {
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }

    this.viewport.removeEventListener("resize", this.schedule);
    this.viewport.removeEventListener("scroll", this.schedule);
    this.reset();
  };

  /**
  Observe the visual viewport only while this input owns focus.
  */
  private focus = () => {
    this.resize();
    this.viewport.addEventListener("resize", this.schedule);
    this.viewport.addEventListener("scroll", this.schedule);
  };

  /**
  Release the exact mounted input and viewport subscriptions.
  */
  disconnect = () => {
    this.input.removeEventListener("focus", this.focus);
    this.input.removeEventListener("blur", this.blur);
    this.blur();
  };

  /** Bind one mounted input and start focus-dependent observation.
  @param input - Mounted textarea.
  @param shell - Chat shell receiving viewport CSS variables.
  @param viewport - Browser's visual viewport.
  */
  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly shell: HTMLElement,
    private readonly viewport: VisualViewport
  ) {
    input.addEventListener("focus", this.focus);
    input.addEventListener("blur", this.blur);

    if (document.activeElement === input) {
      this.focus();
    }
  }
}

/** Start viewport effects after React mounts the input.
@param textarea - Stable ref whose current node is read only during the effect.
@returns Cleanup for a supported mounted viewport, otherwise undefined.
*/
export function connectComposerViewport(textarea: RefObject<HTMLTextAreaElement | null>) {
  const input = textarea.current;
  const shell = input?.closest<HTMLElement>(".chat-shell");
  const viewport = globalThis.visualViewport;

  return input && shell && viewport ? new ComposerViewport(input, shell, viewport).disconnect : undefined;
}
