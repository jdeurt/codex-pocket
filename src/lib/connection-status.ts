import type { Snapshot } from "./protocol";

/**
Describe transport, configuration and turn activity in the connection indicator.
@param state - Current normalized Pocket snapshot.
@param isStreamConnected - Whether the browser currently receives server events.
@returns The most immediate connection or work-status label.
*/
export function connectionStatus(state: Snapshot, isStreamConnected: boolean) {
  if (!isStreamConnected) {
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
