import type { Snapshot } from "./protocol";

export function connectionStatus(state: Snapshot, streamConnected: boolean) {
  if (!streamConnected) {
    return "Connecting…";
  }

  if (state.connection === "unconfigured") {
    return "Set up on your computer";
  }

  if (state.connection !== "connected") {
    return "Reconnecting…";
  }

  if (state.requests.length > 0) {
    return "Waiting for you";
  }

  return state.activeTurnId ? "Working" : "Connected";
}
