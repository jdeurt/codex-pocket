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

      return (async () => {
        const value = await job();

        store.setState({ status });

        return { ok: true as const, value };
      })()
        .catch((error: unknown) => {
          store.setState({ error: error instanceof Error ? error.message : fallback });

          return { ok: false as const };
        })
        .finally(() => {
          store.setState({ busy: false });
        });
    },
  };
}
