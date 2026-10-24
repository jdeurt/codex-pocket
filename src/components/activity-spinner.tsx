"use client";
import { useAgentRead } from "@/hooks/use-agents";
import { subscribeMotion, isReducedMotion, isStaticMotion } from "@/runtime/motion";

import "./activity-spinner.css";
import { spinnerPreferenceSchema } from "@/lib/spinner";
import { useId, useState, useSyncExternalStore } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
Display the selected custom spinner with reduced-motion and reconnect-safe preference updates.
@returns The custom image or native fallback loading indicator.
*/
export function ActivitySpinner() {
  const filterId = `spinner-tone-${useId().replaceAll(":", "")}`;
  const { data } = useAgentRead("/api/spinner", spinnerPreferenceSchema);
  const current = data?.current;
  const [loaded, setLoaded] = useState("");
  const [failed, setFailed] = useState("");
  const isMotionReduced = useSyncExternalStore(subscribeMotion, isReducedMotion, isStaticMotion);

  const showImage = current && !isMotionReduced && failed !== current.id;

  return (
    <span className="custom-activity-spinner-slot" aria-hidden="true" data-activity-spinner="">
      {(!showImage || loaded !== current.id) && (
        <Spinner className="activity-spinner custom-activity-spinner-fallback" viewBox="2 2 20 20" role={undefined} />
      )}
      {showImage && current.tone && (
        <svg width="0" height="0" className="custom-activity-spinner-filter">
          <defs>
            <filter id={filterId} colorInterpolationFilters="sRGB">
              <feColorMatrix
                type="matrix"
                values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0"
              />
              <feComponentTransfer>
                <feFuncR type="linear" slope={current.tone.contrast} intercept={current.tone.brightness} />
                <feFuncG type="linear" slope={current.tone.contrast} intercept={current.tone.brightness} />
                <feFuncB type="linear" slope={current.tone.contrast} intercept={current.tone.brightness} />
                <feFuncA type="identity" />
              </feComponentTransfer>
            </filter>
          </defs>
        </svg>
      )}
      {showImage && (
        // The raw managed asset preserves GIF/WebP frames; Next image optimization would flatten them.
        <img
          key={current.id}
          className="custom-activity-spinner-image"
          style={current.tone ? { filter: `url("#${filterId}")`, opacity: 1 } : undefined}
          src={`/api/spinner/${current.id}`}
          width={28}
          height={28}
          alt=""
          onLoad={setLoaded.bind(undefined, current.id)}
          onError={setFailed.bind(undefined, current.id)}
        />
      )}
    </span>
  );
}
