import { t } from "try";
import { createOperationStore } from "../state/resource";

/** Own a single mutation's lock and result without coupling it to a mounted form.
@returns Observable mutation state and a guarded runner; no operation is automatically retried.
*/
export function createOperation() {
  const store = createOperationStore();

  return {
    store,
    run: async <T>(job: () => Promise<T>, fallback: string, status = "") => {
      if (store.getState().busy) {
        return { ok: false as const };
      }

      store.setState({ busy: true, error: "", status: "" });

      const result = await t(job);

      const error = result.error instanceof Error ? result.error.message : fallback;

      store.setState({
        busy: false,
        status: result.ok ? status : "",
        error: result.ok ? "" : error,
      });

      return result.ok ? { ok: true as const, value: result.value } : { ok: false as const };
    },
  };
}
