import { t } from "try";

/**
Runtime owner of serial execution order; application decisions remain outside the queue.
*/
export class SerialQueue {
  private pending: Promise<undefined> = Promise.resolve(undefined);

  /** Reserve a position, release it on completion, and propagate this operation's outcome.
  @param operation - Explicit effect implementation.
  @param args - Arguments passed to the queued effect.
  @returns This operation's eventual result or rejection.
  */
  run = async <T, Args extends unknown[]>(operation: (...args: Args) => Promise<T>, ...args: Args) => {
    const previous = this.pending;
    const completion = Promise.withResolvers<undefined>();

    this.pending = completion.promise;
    await previous;
    const result = await t(operation, ...args);

    completion.resolve(undefined);

    if (!result.ok) {
      throw result.error;
    }

    return result.value;
  };
}
