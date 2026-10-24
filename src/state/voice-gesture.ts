const CANCEL_DISTANCE = 14;
export const SWIPE_DISTANCE = 68;
const SWIPE_WIDTH = 64;

export interface GesturePointer {
  id: number;
  x: number;
  y: number;
}
export interface VoiceGestureState {
  pointer?: GesturePointer;
  holding: boolean;
  armed: boolean;
  cancelled: boolean;
  progress: number;
  suppressClick: boolean;
}

/** Create an idle voice gesture without timers or browser resources.
@returns Initial gesture projection.
*/
export function initialVoiceGesture(): VoiceGestureState {
  return { holding: false, armed: false, cancelled: false, progress: 0, suppressClick: false };
}

/** Mark a hold only when its original pointer still owns the gesture.
@param state - Current gesture projection.
@param pointerId - Pointer whose timer expired.
@returns Unchanged state or an active hold.
*/
export function heldGesture(state: VoiceGestureState, pointerId: number) {
  return state.pointer?.id === pointerId && !state.cancelled ? { ...state, holding: true } : state;
}

/** Derive cancellation and swipe progress from explicit pointer coordinates.
@param state - Current gesture projection.
@param pointer - Latest coordinates for one pointer.
@returns Next projection without modifying the original gesture.
*/
export function movedGesture(state: VoiceGestureState, pointer: GesturePointer): VoiceGestureState {
  if (state.pointer?.id !== pointer.id) {
    return state;
  }

  const dx = pointer.x - state.pointer.x;
  const dy = pointer.y - state.pointer.y;

  if (!state.holding) {
    return Math.abs(dx) > CANCEL_DISTANCE || Math.abs(dy) > CANCEL_DISTANCE ? { ...state, cancelled: true } : state;
  }

  const progress = Math.abs(dx) < SWIPE_WIDTH ? Math.min(1, Math.max(0, -dy / SWIPE_DISTANCE)) : 0;

  return { ...state, progress, armed: progress === 1 };
}

/** Release a matching pointer while retaining the following click's suppression decision.
@param state - Current gesture projection.
@param pointerId - Released pointer identity.
@returns Reset projection and whether the runtime should start voice.
*/
export function releasedGesture(state: VoiceGestureState, pointerId: number) {
  return state.pointer?.id === pointerId
    ? {
        state: { ...initialVoiceGesture(), suppressClick: state.holding || state.cancelled },
        shouldStart: state.armed && !state.cancelled,
      }
    : { state, shouldStart: false };
}

/** Decide whether a native click is a tap, a stop request or a suppressed gesture click.
@param state - Current gesture projection.
@param isActive - Whether voice currently owns the button.
@param detail - Native click count; zero denotes keyboard activation.
@returns Updated suppression state and an explicit interaction action.
*/
export function clickedGesture(state: VoiceGestureState, isActive: boolean, detail: number) {
  const action = isActive ? "stop" : "tap";
  const isSuppressed = state.suppressClick && detail > 0;

  return { state: { ...state, suppressClick: false }, action: isSuppressed ? undefined : action };
}
