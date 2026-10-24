import { t } from "try";

/** Reserve each operation's place before it can run, while allowing recovery after earlier failure.
@returns A queue that propagates each operation's own result to its caller.
*/
export function createSerialQueue() {
  let pending: Promise<unknown> = Promise.resolve();

  return <T>(operation: () => Promise<T>) => {
    const previous = pending;
    const run = async () => {
      // An earlier failure belongs to its caller and must not poison later work.
      await t(previous);

      return operation();
    };
    const next = run();

    pending = next;

    return next;
  };
}
