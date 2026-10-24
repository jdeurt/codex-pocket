export interface ResourceState<T> {
  data?: T;
  error?: string;
  isLoading: boolean;
}

export interface OperationState {
  busy: boolean;
  error: string;
  status: string;
}

/** Create resource data without subscribing or fetching.
@param data - Optional server-hydrated value.
@returns Initial resource projection.
*/
export function resourceState<T>(data?: T): ResourceState<T> {
  return { data, isLoading: data === undefined };
}

/** Create an idle operation value.
@returns Initial transient operation state.
*/
export function operationState(): OperationState {
  return { busy: false, error: "", status: "" };
}

/** Project a completed operation without performing it.
@param isSuccessful - Whether the runtime operation succeeded.
@param error - Runtime failure, when present.
@param fallback - User-facing fallback for non-Error failures.
@param status - Success confirmation.
@returns Completed operation state.
*/
export function completedOperation(
  isSuccessful: boolean,
  error: unknown,
  fallback: string,
  status: string
): OperationState {
  const message = error instanceof Error ? error.message : fallback;

  return { busy: false, status: isSuccessful ? status : "", error: isSuccessful ? "" : message };
}

/** Select the shared pending-operation flag.
@param state - Published operation state.
@returns Whether persistence is in progress.
*/
export function isOperationBusy(state: OperationState) {
  return state.busy;
}
