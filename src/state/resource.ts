import { createStore } from "zustand/vanilla";

export interface ResourceState<T> {
  data?: T;
  error?: string;
  isLoading: boolean;
}

/** Create a validated resource's isolated observable state.
@param data - Optional server-hydrated data; refreshed without clearing the last good value.
@returns Vanilla store usable without React.
*/
export function createResourceStore<T>(data?: T) {
  return createStore<ResourceState<T>>(() => ({ data, isLoading: data === undefined }));
}

export interface OperationState {
  busy: boolean;
  error: string;
  status: string;
}

/** Create independent mutation state so unrelated operations cannot clear each other's errors.
@returns Empty operation state, never persisted or hydrated as in-flight work.
*/
export function createOperationStore() {
  return createStore<OperationState>(() => ({ busy: false, error: "", status: "" }));
}
