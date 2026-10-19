import type { Snapshot } from "./protocol";

export function modelDescription(state: Snapshot) {
  if (!state.model) {
    return "Model unavailable";
  }

  if (state.reasoningEffort === undefined) {
    return `${state.model} · Reasoning unavailable`;
  }

  const effort = state.reasoningEffort === null ? "Default reasoning" : `${state.reasoningEffort} reasoning`;

  return `${state.model} · ${effort}`;
}
