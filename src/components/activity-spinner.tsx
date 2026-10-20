"use client";
import "./activity-spinner.css";
import { type SpinnerPreference, spinnerPreferenceSchema } from "@/lib/spinner";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Spinner } from "@/components/ui/spinner";

const POLL_MS = 2000;
const motionQuery = "(prefers-reduced-motion: reduce)";
/**
Observe the native reduced-motion preference for one mounted spinner.
@param callback - Stable external-store listener registered for media-query changes.
@returns Cleanup that removes the same listener.
*/
const subscribeMotion = (callback: () => void) => {
  const media = globalThis.matchMedia(motionQuery);

  media.addEventListener("change", callback);

  return () => {
    media.removeEventListener("change", callback);
  };
};
/**
Read the current browser reduced-motion preference.
@returns Whether optional custom image motion should be avoided.
*/
const isReducedMotion = () => globalThis.matchMedia(motionQuery).matches;
/**
Use the conservative static-motion snapshot during server rendering.
@returns True, keeping animated custom assets out of the server snapshot.
*/
const isStaticMotion = () => true;

/**
Display the selected custom spinner with reduced-motion and reconnect-safe preference updates.
@returns The custom image or native fallback loading indicator.
*/
export function ActivitySpinner() {
  const filterId = `spinner-tone-${useId().replaceAll(":", "")}`;
  const [current, setCurrent] = useState<SpinnerPreference["current"]>(null);
  const [loaded, setLoaded] = useState("");
  const [failed, setFailed] = useState("");
  const isMotionReduced = useSyncExternalStore(subscribeMotion, isReducedMotion, isStaticMotion);

  const showImage = current && !isMotionReduced && failed !== current.id;

  useEffect(() => {
    let isRefreshing = false;

    const abort = new AbortController();

    async function readPreference() {
      const response = await fetch("/api/spinner", { cache: "no-store", signal: abort.signal });

      if (response.ok) {
        setCurrent(spinnerPreferenceSchema.parse(await response.json()).current);
      }
    }

    async function refresh() {
      if (isRefreshing || document.hidden || abort.signal.aborted) {
        return;
      }

      isRefreshing = true;

      try {
        await readPreference();
      } catch {
        // Keep the last preference through a transient disconnect; initial state is the SVG.
      } finally {
        isRefreshing = false;
      }
    }

    const visible = () => void refresh();

    function startPolling() {
      document.addEventListener("visibilitychange", visible);
      void refresh();

      return setInterval(() => void refresh(), POLL_MS);
    }

    const timer = startPolling();

    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

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
