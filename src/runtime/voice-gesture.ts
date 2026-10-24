import { type MouseEvent, type PointerEvent } from "react";
import { observable } from "./stores";
import {
  initialVoiceGesture,
  heldGesture,
  movedGesture,
  releasedGesture,
  clickedGesture,
} from "../state/voice-gesture";

const HOLD_MS = 350;

export interface VoiceGestureOptions {
  active: boolean;
  enabled: boolean;
  onTap: () => void;
  onStart: () => void;
  onStop: () => void;
}

/**
Own pointer capture, the hold timer and publication of pure gesture transitions.
*/
export class VoiceGesture {
  private timer?: ReturnType<typeof setTimeout>;

  /** Adopt a timer expiration only while its pointer still owns the gesture.
  @param pointerId - Pointer that reserved the hold timer.
  */
  private hold = (pointerId: number) => {
    this.store.setState(heldGesture(this.store.getState(), pointerId), true);
  };

  /**
  Release the timer when React unmounts the button.
  */
  private disconnect = () => {
    clearTimeout(this.timer);
  };

  readonly store = observable(initialVoiceGesture());

  /** Bind timer cleanup to the mounted button lifetime.
  @returns Timer cleanup callback.
  */
  connect = () => this.disconnect;

  /** Capture an eligible pointer and reserve its hold timer.
  @param options - Current button availability and actions.
  @param event - Native pointer down event.
  */
  down = (options: VoiceGestureOptions, event: PointerEvent<HTMLButtonElement>) => {
    if (options.active || !options.enabled) {
      return;
    }

    clearTimeout(this.timer);
    this.store.setState(
      {
        ...initialVoiceGesture(),
        pointer: {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        },
      },
      true
    );
    this.timer = setTimeout(this.hold.bind(undefined, event.pointerId), HOLD_MS);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Publish swipe geometry and cancel a hold that moved before activation.
  @param event - Latest native pointer coordinates.
  */
  move = (event: PointerEvent<HTMLButtonElement>) => {
    const state = movedGesture(this.store.getState(), { id: event.pointerId, x: event.clientX, y: event.clientY });

    if (state.cancelled) {
      clearTimeout(this.timer);
    }

    this.store.setState(state, true);
  };

  /** Release the matching pointer and execute the explicit start decision.
  @param onStart - Current voice-start action.
  @param event - Released native pointer.
  */
  up = (onStart: () => void, event: PointerEvent<HTMLButtonElement>) => {
    const previous = this.store.getState();
    const result = releasedGesture(previous, event.pointerId);

    if (result.state === previous) {
      return;
    }

    clearTimeout(this.timer);
    this.store.setState(result.state, true);

    if (result.shouldStart) {
      onStart();
    }
  };

  /**
  Cancel pointer capture without treating the next native click as a tap.
  */
  cancel = () => {
    if (!this.store.getState().pointer) {
      return;
    }

    clearTimeout(this.timer);
    this.store.setState({ ...initialVoiceGesture(), suppressClick: true }, true);
  };

  /** Execute the pure click decision using current UI actions.
  @param options - Current voice state and button actions.
  @param event - Pointer or keyboard click.
  */
  click = (options: VoiceGestureOptions, event: MouseEvent<HTMLButtonElement>) => {
    const result = clickedGesture(this.store.getState(), options.active, event.detail);

    this.store.setState(result.state, true);

    if (result.action === "stop") {
      options.onStop();
    } else if (result.action === "tap") {
      options.onTap();
    }
  };
}
