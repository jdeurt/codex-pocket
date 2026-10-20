import { Bridge } from "./bridge-session";

export { Bridge } from "./bridge-session";

declare global {
  var codexPocketBridge: Bridge | undefined;
}

export const bridge = globalThis.codexPocketBridge ?? new Bridge();

if (!globalThis.codexPocketBridge) {
  Object.defineProperty(globalThis, "codexPocketBridge", { value: bridge, configurable: true });
}
