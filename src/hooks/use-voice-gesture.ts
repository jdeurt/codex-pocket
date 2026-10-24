"use client";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { VoiceGesture, type VoiceGestureOptions } from "../runtime/voice-gesture";
import { SWIPE_DISTANCE } from "../state/voice-gesture";

/** Create an isolated pointer runtime without registering browser resources.
@returns Gesture owner for one mounted button.
*/
function createGesture() {
  return new VoiceGesture();
}

/** Subscribe the button to gesture data and bind its current actions explicitly.
@param options - Current availability and tap/start/stop actions.
@returns Rendering values and native event bindings.
*/
export function useVoiceGesture(options: VoiceGestureOptions) {
  const [gesture] = useState(createGesture);
  const state = useStore(gesture.store);

  useEffect(gesture.connect, [gesture]);

  return {
    holding: state.holding,
    armed: state.armed,
    offset: state.progress * SWIPE_DISTANCE,
    onPointerDown: gesture.down.bind(undefined, options),
    onPointerMove: gesture.move,
    onPointerUp: gesture.up.bind(undefined, options.onStart),
    onPointerCancel: gesture.cancel,
    onLostPointerCapture: gesture.cancel,
    onClick: gesture.click.bind(undefined, options),
  };
}
