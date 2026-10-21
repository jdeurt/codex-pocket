"use client";
/* eslint-disable jdeurt/const-on-top -- Pointer transitions depend on prior gesture state. */
import { type MouseEvent, type PointerEvent, useRef, useState } from "react";

const HOLD_MS = 350;
const CANCEL_DISTANCE = 14;
const SWIPE_DISTANCE = 68;
const SWIPE_WIDTH = 64;

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  holding: boolean;
  armed: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
Keep send taps separate from held swipe activation and cancelled pointer gestures.
@param options - Current button state and tap, start, and stop actions.
@returns Pointer and click handlers plus the pill position and armed state.
*/
export function useVoiceGesture(options: {
  active: boolean;
  enabled: boolean;
  onTap: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const [armed, setArmed] = useState(false);
  const [progress, setProgress] = useState(0);
  const suppressClick = useRef(false);
  const gesture = useRef<Gesture | null>(null);

  function release() {
    if (gesture.current) {
      clearTimeout(gesture.current.timer);
    }

    gesture.current = null;
    setHolding(false);
    setArmed(false);
    setProgress(0);
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (options.active || !options.enabled) {
      return;
    }

    suppressClick.current = false;
    const pointerId = event.pointerId;

    gesture.current = {
      pointerId,
      x: event.clientX,
      y: event.clientY,
      holding: false,
      armed: false,
      cancelled: false,
      timer: setTimeout(() => {
        if (gesture.current?.pointerId !== pointerId || gesture.current.cancelled) {
          return;
        }

        gesture.current.holding = true;
        setHolding(true);
      }, HOLD_MS),
    };
    event.currentTarget.setPointerCapture(pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;

    if (current?.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;

    if (!current.holding && (Math.abs(dx) > CANCEL_DISTANCE || Math.abs(dy) > CANCEL_DISTANCE)) {
      current.cancelled = true;
      clearTimeout(current.timer);
    }

    if (!current.holding) {
      return;
    }

    const nextProgress = Math.abs(dx) < SWIPE_WIDTH ? Math.min(1, Math.max(0, -dy / SWIPE_DISTANCE)) : 0;

    current.armed = nextProgress === 1;
    setProgress(nextProgress);
    setArmed(current.armed);
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;

    if (current?.pointerId !== event.pointerId) {
      return;
    }

    suppressClick.current = current.holding || current.cancelled;

    const isActivate = current.armed && !current.cancelled;

    release();

    if (isActivate) {
      options.onStart();
    }
  }

  function onPointerCancel() {
    if (!gesture.current) {
      return;
    }

    suppressClick.current = true;
    release();
  }

  function onClick(event: MouseEvent<HTMLButtonElement>) {
    const shouldSuppressPointerClick = suppressClick.current && event.detail > 0;

    suppressClick.current = false;

    if (shouldSuppressPointerClick) {
      return;
    }

    if (options.active) {
      options.onStop();
    } else {
      options.onTap();
    }
  }

  return {
    holding,
    armed,
    offset: progress * SWIPE_DISTANCE,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture: onPointerCancel,
    onClick,
  };
}
