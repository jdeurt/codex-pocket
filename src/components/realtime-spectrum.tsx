"use client";
/* eslint-disable @typescript-eslint/no-magic-numbers, jsdoc/require-param, jsdoc/require-returns -- Canvas drawing uses sequential measurements and fixed visual tuning constants. */
import "./realtime-spectrum.css";
import { useEffect, useRef } from "react";

const BAR_COUNT = 32;

/**
Draw genuine analyser frequency ranges with separate reversed agent ordering.
*/
export function RealtimeSpectrum({
  input,
  output,
  status,
}: {
  input?: AnalyserNode;
  output?: AnalyserNode;
  status: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;

    if (!element || !input || !output) {
      return;
    }

    const context = element.getContext("2d");

    if (!context) {
      return;
    }

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const inputBytes = new Uint8Array(input.frequencyBinCount);
    const outputBytes = new Uint8Array(output.frequencyBinCount);
    const levels = Array.from({ length: BAR_COUNT }, () => ({ input: 0, output: 0 }));

    let frame = 0;
    let isRunning = true;

    const draw = () => {
      if (!isRunning) {
        return;
      }

      const bounds = element.getBoundingClientRect();
      const scale = devicePixelRatio || 1;

      element.width = Math.max(1, Math.round(bounds.width * scale));
      element.height = Math.max(1, Math.round(bounds.height * scale));
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      input.getByteFrequencyData(inputBytes);
      output.getByteFrequencyData(outputBytes);
      const gap = 4;
      const barWidth = Math.max(2, (bounds.width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
      const mid = bounds.height / 2;
      const composer = element.closest<HTMLElement>(".composer");
      const composerBounds = composer?.getBoundingClientRect();
      const inset = composerBounds ? bounds.left - composerBounds.left : 0;
      const radius =
        composer && composerBounds
          ? Math.min(
              composerBounds.height / 2,
              Number(getComputedStyle(composer).borderTopLeftRadius.replace("px", ""))
            )
          : bounds.height / 2;
      const envelope = (localX: number) => {
        const distance = Math.min(inset + localX, inset + bounds.width - localX - barWidth);

        const capsule = distance >= radius ? 1 : Math.sqrt(1 - (1 - Math.max(0, distance) / radius) ** 2);

        return capsule ** 2.45;
      };

      for (let i = 0; i < BAR_COUNT; i++) {
        const low = 80 * 100 ** (i / BAR_COUNT);
        const high = 80 * 100 ** ((i + 1) / BAR_COUNT);
        const from = Math.min(inputBytes.length - 1, Math.floor(low / (input.context.sampleRate / input.fftSize)));
        const to = Math.min(
          inputBytes.length,
          Math.max(from + 1, Math.ceil(high / (input.context.sampleRate / input.fftSize)))
        );
        const fromOut = Math.min(
          outputBytes.length - 1,
          Math.floor(low / (output.context.sampleRate / output.fftSize))
        );
        const toOut = Math.min(
          outputBytes.length,
          Math.max(fromOut + 1, Math.ceil(high / (output.context.sampleRate / output.fftSize)))
        );

        let user = 0;
        let agent = 0;

        for (let bin = from; bin < to; bin++) {
          user = Math.max(user, inputBytes[bin]);
        }

        for (let bin = fromOut; bin < toOut; bin++) {
          agent = Math.max(agent, outputBytes[bin]);
        }

        const targetInput = Math.pow(user / 255, 1.5);
        const targetOutput = Math.pow(agent / 255, 1.5);
        const level = levels[i];

        level.input += (targetInput - level.input) * (targetInput > level.input ? 0.45 : 0.13);
        level.output += (targetOutput - level.output) * (targetOutput > level.output ? 0.45 : 0.13);
        const x = i * (barWidth + gap);
        const agentX = (BAR_COUNT - 1 - i) * (barWidth + gap);
        const maxHalf = bounds.height * 0.42;
        const userHalf = (1.5 + level.input * maxHalf) * envelope(x);
        const agentHalf = (1.5 + level.output * maxHalf) * envelope(agentX);

        context.fillStyle = "rgba(183, 218, 214, .78)";
        context.beginPath();
        context.roundRect(x, mid - userHalf, barWidth, userHalf * 2, barWidth / 2);
        context.fill();
        context.globalCompositeOperation = "screen";
        context.fillStyle = "rgba(194, 178, 215, .62)";
        context.beginPath();
        context.roundRect(agentX, mid - agentHalf, barWidth, agentHalf * 2, barWidth / 2);
        context.fill();
        context.globalCompositeOperation = "source-over";
      }

      if (!reduced.matches) {
        frame = requestAnimationFrame(draw);
      }
    };

    draw();
    const onMotionChange = () => {
      cancelAnimationFrame(frame);
      draw();
    };

    reduced.addEventListener("change", onMotionChange);

    return () => {
      isRunning = false;
      cancelAnimationFrame(frame);
      reduced.removeEventListener("change", onMotionChange);
    };
  }, [input, output]);

  let label = "Listening";

  if (status === "starting") {
    label = "Connecting voice…";
  } else if (status === "stopping") {
    label = "Stopping voice…";
  }

  return (
    <div className="realtime-spectrum" role="status" aria-label={`Realtime voice ${status}`}>
      <canvas ref={canvas} aria-hidden="true" />
      <span className="realtime-spectrum-label">{label}</span>
    </div>
  );
}
