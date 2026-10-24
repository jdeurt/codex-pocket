export type EventBinding = readonly [EventTarget, string, EventListenerOrEventListenerObject];

/**
Runtime owner of symmetric native event registration and teardown.
*/
export class EventBindings {
  /**
  Remove precisely the listeners registered by this owner.
  */
  stop = () => {
    for (const [target, type, listener] of this.bindings) {
      target.removeEventListener(type, listener);
    }
  };

  /** Register a concrete set of native callbacks.
  @param bindings - Explicit event targets, names and module-scope implementations.
  */
  constructor(private readonly bindings: readonly EventBinding[]) {
    for (const [target, type, listener] of bindings) {
      target.addEventListener(type, listener);
    }
  }
}

/**
Represent an inactive subscription without allocating resources.
*/
export function inactiveSubscription() {
  // There is no mounted resource to start or release.
}
