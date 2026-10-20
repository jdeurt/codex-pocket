"use client";
import "./activity-spinner.css";
import { type SpinnerPreference, spinnerPreferenceSchema } from "@/lib/spinner";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Spinner } from "@/components/ui/spinner";

const POLL_MS = 2000;
const motionQuery = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (callback: () => void) => {
  const media = globalThis.matchMedia(motionQuery);

  media.addEventListener("change", callback);

  return () => {
    media.removeEventListener("change", callback);
  };
};
const reducedMotion = () => globalThis.matchMedia(motionQuery).matches;
const staticMotion = () => true;

export function ActivitySpinner() {
  const filterId = `spinner-tone-${useId().replaceAll(":", "")}`;
  const [current, setCurrent] = useState<SpinnerPreference["current"]>(null);
  const [loaded, setLoaded] = useState("");
  const [failed, setFailed] = useState("");
  const reduce = useSyncExternalStore(subscribeMotion, reducedMotion, staticMotion);

  useEffect(() => {
    const abort = new AbortController();

    let refreshing = false;

    const refresh = async () => {
      if (document.hidden || refreshing || abort.signal.aborted) {
        return;
      }

      refreshing = true;

      try {
        const response = await fetch("/api/spinner", { cache: "no-store", signal: abort.signal });

        if (response.ok) {
          const preference = spinnerPreferenceSchema.parse(await response.json());

          setCurrent(preference.current);
        }
      } catch {
        // Keep the last preference through a transient disconnect; initial state is the SVG.
      } finally {
        refreshing = false;
      }
    };
    const visible = () => void refresh();

    document.addEventListener("visibilitychange", visible);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);

    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const showImage = current && !reduce && failed !== current.id;

  return (
    <span className="custom-activity-spinner-slot" aria-hidden="true" data-activity-spinner="">
      {(!showImage || loaded !== current.id) && (
        <Spinner className="activity-spinner custom-activity-spinner-fallback" role={undefined} />
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
          width={32}
          height={32}
          alt=""
          onLoad={() => {
            setLoaded(current.id);
          }}
          onError={() => {
            setFailed(current.id);
          }}
        />
      )}
    </span>
  );
}
