import { type RefObject } from "react";
import { silentSpectrum, sampledSpectrum, spectrumBars, type SpectrumBar } from "../state/spectrum";
import { MOTION_QUERY } from "./motion";

const HALF = 2;

/** Draw one computed rectangle with the caller's compositing style.
@param context - Native canvas owner.
@param bar - Pure geometry.
@param color - Current channel color.
*/
function drawBar(context: CanvasRenderingContext2D, bar: SpectrumBar, color: string) {
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(bar.x, bar.y, bar.width, bar.height, bar.width / HALF);
  context.fill();
}

/**
Effectful owner of sampling, canvas rendering and one animation lifetime.
*/
class SpectrumRenderer {
  private readonly reduced = matchMedia(MOTION_QUERY);
  private readonly inputBytes;
  private readonly outputBytes;
  private readonly resize;
  private levels = silentSpectrum(0);
  private frame = 0;
  private isRunning = true;

  /**
  Sample native analysers, project immutable state and render one frame.
  */
  private draw = () => {
    if (!this.isRunning) {
      return;
    }

    const bounds = this.element.getBoundingClientRect();
    const scale = devicePixelRatio || 1;

    this.element.width = Math.max(1, Math.round(bounds.width * scale));
    this.element.height = Math.max(1, Math.round(bounds.height * scale));
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.context.clearRect(0, 0, bounds.width, bounds.height);
    this.input.getByteFrequencyData(this.inputBytes);
    this.output.getByteFrequencyData(this.outputBytes);

    this.levels = sampledSpectrum(
      this.levels,
      { bytes: this.inputBytes, binWidth: this.input.context.sampleRate / this.input.fftSize },
      { bytes: this.outputBytes, binWidth: this.output.context.sampleRate / this.output.fftSize },
      bounds.width
    );
    const composer = this.element.closest<HTMLElement>(".composer");
    const composerBounds = composer?.getBoundingClientRect();
    const inset = composerBounds ? bounds.left - composerBounds.left : 0;
    const radius =
      composer && composerBounds
        ? Math.min(
            composerBounds.height / HALF,
            Number(getComputedStyle(composer).borderTopLeftRadius.replace("px", ""))
          )
        : bounds.height / HALF;
    const bars = spectrumBars(this.levels, { width: bounds.width, height: bounds.height, inset, radius });

    for (const bar of bars) {
      drawBar(this.context, bar.input, "rgba(183, 218, 214, .78)");
      this.context.globalCompositeOperation = "screen";
      drawBar(this.context, bar.output, "rgba(194, 178, 215, .62)");
      this.context.globalCompositeOperation = "source-over";
    }

    if (!this.reduced.matches) {
      this.frame = requestAnimationFrame(this.draw);
    }
  };

  /**
  Restart the native frame schedule when motion preferences change.
  */
  private motionChanged = () => {
    cancelAnimationFrame(this.frame);
    this.draw();
  };

  /**
  Keep fixed-width bars fitted after a resize when animation is disabled.
  */
  private resized = () => {
    if (this.reduced.matches) {
      this.draw();
    }
  };

  /**
  Release the animation and exact preference listener.
  */
  stop = () => {
    this.isRunning = false;
    cancelAnimationFrame(this.frame);
    this.reduced.removeEventListener("change", this.motionChanged);
    this.resize.disconnect();
  };

  /** Start one mounted native renderer.
  @param element - Mounted canvas.
  @param context - Its native drawing context.
  @param input - Microphone analyser.
  @param output - Agent analyser.
  */
  constructor(
    private readonly element: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly input: AnalyserNode,
    private readonly output: AnalyserNode
  ) {
    this.inputBytes = new Uint8Array(input.frequencyBinCount);
    this.outputBytes = new Uint8Array(output.frequencyBinCount);
    this.resize = new ResizeObserver(this.resized);
    this.resize.observe(element);
    this.draw();
    this.reduced.addEventListener("change", this.motionChanged);
  }
}

/** Bind a renderer to the mounted canvas and explicit media owners.
@param canvas - Mounted element reference.
@param input - Optional microphone analyser.
@param output - Optional agent analyser.
@returns Native cleanup when both analysers and canvas are available.
*/
export function renderSpectrum(
  canvas: RefObject<HTMLCanvasElement | null>,
  input?: AnalyserNode,
  output?: AnalyserNode
) {
  const element = canvas.current;
  const context = element?.getContext("2d");

  if (element && context && input && output) {
    return new SpectrumRenderer(element, context, input, output).stop;
  }
}
