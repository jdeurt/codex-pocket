import { EventBindings } from "./events";

export const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Observe the native motion preference for one mounted consumer.
@param callback - External-store listener.
@returns Cleanup that removes the same listener.
*/
export function subscribeMotion(callback: () => void) {
  return new EventBindings([[globalThis.matchMedia(MOTION_QUERY), "change", callback]]).stop;
}

/** Read the native motion preference.
@returns Whether optional animation should be avoided.
*/
export function isReducedMotion() {
  return globalThis.matchMedia(MOTION_QUERY).matches;
}

/** Supply the conservative server snapshot before native preferences are available.
@returns True, keeping optional animation out of server markup.
*/
export function isStaticMotion() {
  return true;
}
