"use client";
import "./realtime-spectrum.css";
import { useEffect, useRef } from "react";

import { useBoundCallback } from "@/hooks/use-bound-callback";
import { renderSpectrum } from "@/runtime/spectrum";
import { Spinner } from "./ui/spinner";

/**
Draw genuine analyser frequency ranges with separate reversed agent ordering.
@param props - Native analysers and current voice status.
@returns Live spectrum and accessible voice status.
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

  const connect = useBoundCallback(renderSpectrum, canvas, input, output);

  useEffect(connect, [connect]);

  let label = "Listening";

  if (status === "starting") {
    label = "Connecting voice…";
  } else if (status === "stopping") {
    label = "Ending call…";
  }

  return (
    <div className="realtime-spectrum" data-state={status} role="status" aria-label={`Realtime voice ${status}`}>
      <canvas ref={canvas} aria-hidden="true" />
      <span className="realtime-spectrum-label">
        {status === "stopping" && (
          <Spinner className="size-3 motion-reduce:animate-none" aria-hidden="true" role={undefined} />
        )}
        {label}
      </span>
    </div>
  );
}
