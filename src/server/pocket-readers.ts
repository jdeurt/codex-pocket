import { type Bridge } from "./bridge-session";

declare global {
  var namedPocketReaders: Map<string, Bridge> | undefined;
}
export const parentReaders = globalThis.namedPocketReaders ?? new Map<string, Bridge>();

if (!globalThis.namedPocketReaders) {
  Object.defineProperty(globalThis, "namedPocketReaders", { value: parentReaders, configurable: true });
}
