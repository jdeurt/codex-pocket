import type { Snapshot } from "./protocol";

/**
Describe the selected model without inventing unavailable reasoning metadata.
@param state - Current normalized parent or agent snapshot.
@returns The model and reasoning label, including unavailable/default states.
*/
export function modelDescription(state: Snapshot) {
  if (!state.model) {
    return "Model unavailable";
  }

  if (state.reasoningEffort !== undefined) {
    const effort = state.reasoningEffort === null ? "Default reasoning" : `${state.reasoningEffort} reasoning`;

    return `${state.model} · ${effort}`;
  }

  return `${state.model} · Reasoning unavailable`;
}
