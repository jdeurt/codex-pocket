import { type RefObject } from "react";
import { completedSwipe, swipeDirection, type SwipePoint } from "../state/navigation-swipe";

type Navigate = (() => void) | undefined;
export interface SwipeActions {
  left: Navigate;
  right: Navigate;
}
interface SwipeRuntime {
  start: SwipePoint | null;
  identifier: number | null;
  actions: RefObject<SwipeActions>;
  signal: AbortSignal;
  gesture?: AbortController;
}

/** Update navigation actions without interrupting a touch already in progress.
@param actions - Mounted callback holder.
@param left - Current leftward action.
@param right - Current rightward action.
*/
export function updateSwipeActions(actions: RefObject<SwipeActions>, left: Navigate, right: Navigate) {
  actions.current = { left, right };
}

/** Preserve editing, text selection, and horizontally scrollable content.
@param target - Native touch target.
@param surface - Navigation surface containing the target.
@returns Whether this target can start navigation.
*/
function canSwipe(target: EventTarget | null, surface: HTMLElement) {
  if (
    !(target instanceof Element) ||
    !surface.contains(target) ||
    target.closest("input, textarea, select, [contenteditable], [role=slider]")
  ) {
    return false;
  }

  for (let element: Element | null = target; element && element !== surface; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowX;

    if (element.scrollWidth > element.clientWidth && (overflow === "auto" || overflow === "scroll")) {
      return false;
    }
  }

  return !surface.ownerDocument.getSelection()?.toString();
}

/** Clear native gesture ownership on cancellation or completion.
@param runtime - Mounted listener state.
*/
function cancelSwipe(runtime: SwipeRuntime) {
  runtime.gesture?.abort();
  runtime.gesture = undefined;
  runtime.start = null;
  runtime.identifier = null;
}

/** Give vertical scrolling ownership until a horizontal intent is established.
@param runtime - Mounted listener state.
@param event - Native touch movement.
*/
function moveSwipe(runtime: SwipeRuntime, event: TouchEvent) {
  const touch = event.touches[0];

  if (!runtime.start || event.touches.length !== 1 || touch.identifier !== runtime.identifier) {
    cancelSwipe(runtime);

    return;
  }

  const direction = swipeDirection(runtime.start, { x: touch.clientX, y: touch.clientY });

  if (direction === "vertical") {
    cancelSwipe(runtime);
  } else if (
    (direction === "left" && runtime.actions.current.left) ||
    (direction === "right" && runtime.actions.current.right)
  ) {
    event.preventDefault();
  }
}

/** Navigate once on release and suppress the swipe's emulated click.
@param runtime - Mounted listener state.
@param surface - Mounted navigation surface.
@param event - Native touch release.
*/
function endSwipe(runtime: SwipeRuntime, surface: HTMLElement, event: TouchEvent) {
  const start = runtime.start;
  const identifier = runtime.identifier;

  cancelSwipe(runtime);

  if (!start || event.touches.length > 0 || surface.ownerDocument.getSelection()?.toString()) {
    return;
  }

  const touch = event.changedTouches[0];

  if (touch.identifier !== identifier) {
    return;
  }

  const direction = completedSwipe(start, { x: touch.clientX, y: touch.clientY });
  const navigate = direction ? runtime.actions.current[direction] : undefined;

  if (!navigate) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  navigate();
}

/** Retain a single eligible touch without interfering with native taps.
@param runtime - Mounted listener state.
@param surface - Mounted navigation surface.
@param event - Native touch start.
*/
function startSwipe(runtime: SwipeRuntime, surface: HTMLElement, event: TouchEvent) {
  cancelSwipe(runtime);

  const target = event.target;

  if (!(target instanceof HTMLElement) || event.touches.length !== 1 || !canSwipe(target, surface)) {
    return;
  }

  const touch = event.touches[0];

  runtime.start = { x: touch.clientX, y: touch.clientY };
  runtime.identifier = touch.identifier;
  runtime.gesture = new AbortController();

  // The touched transcript row can unmount while history loads or virtualizes.
  // Own the remaining events on that exact target throughout the gesture.
  const options = { passive: false, signal: AbortSignal.any([runtime.signal, runtime.gesture.signal]) };

  target.addEventListener("touchmove", moveSwipe.bind(undefined, runtime), options);
  target.addEventListener("touchend", endSwipe.bind(undefined, runtime, surface), options);
  target.addEventListener("touchcancel", cancelSwipe.bind(undefined, runtime), options);
}

/** Attach cancellable native listeners so horizontal gestures can prevent browser defaults.
@param surface - Mounted navigation surface.
@param isEnabled - Whether this view currently owns navigation.
@param actions - Current navigation callbacks, updated without replacing listeners.
@returns Listener cleanup, if a surface is active.
*/
export function connectNavigationSwipe(
  surface: HTMLElement | null,
  isEnabled: boolean,
  actions: RefObject<SwipeActions>
) {
  if (!surface || !isEnabled) {
    return;
  }

  const controller = new AbortController();
  const runtime: SwipeRuntime = { start: null, identifier: null, actions, signal: controller.signal };
  const options = { passive: false, signal: controller.signal };

  surface.addEventListener("touchstart", startSwipe.bind(undefined, runtime, surface), options);

  return controller.abort.bind(controller);
}
