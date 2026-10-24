import { operationState, completedOperation } from "../state/resource";
import { t } from "try";
import { observable } from "../runtime/stores";

/**
Runtime owner of one operation lock and its observable result.
*/
export class Operation {
  readonly store = observable(operationState());

  /** Execute an explicitly parameterized effect and publish its pure completion projection.
  @param job - Module-scope effect implementation.
  @param fallback - User-facing failure text.
  @param status - Success confirmation.
  @param args - Explicit arguments passed to the effect.
  @returns Whether work completed and its successful value.
  */
  run = async <T, Args extends unknown[]>(
    job: (...args: Args) => Promise<T>,
    fallback: string,
    status = "",
    ...args: Args
  ) => {
    if (this.store.getState().busy) {
      return { ok: false as const };
    }

    this.store.setState({ busy: true, error: "", status: "" });
    const result = await t(job, ...args);

    this.store.setState(completedOperation(result.ok, result.error, fallback, status));

    return result.ok ? { ok: true as const, value: result.value } : { ok: false as const };
  };
}
