import { DelegationStore } from "./delegations";
import { localDirectory } from "./local-state";

declare global {
  var codexPocketDelegations: DelegationStore | undefined;
}

/**
Acquire and register the process's private delegation persistence owner lazily.
@returns Newly registered concrete delegation store.
*/
function createDelegationStore() {
  const store = new DelegationStore(localDirectory());

  Object.defineProperty(globalThis, "codexPocketDelegations", { value: store, configurable: true });

  return store;
}

/**
Reuse the process's existing private delegation owner or acquire it on first use.
@returns Process-local parent and child persistence owner.
*/
export function delegations() {
  return globalThis.codexPocketDelegations ?? createDelegationStore();
}
