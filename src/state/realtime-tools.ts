import { type Data, object, string } from "../lib/protocol";
import { z } from "zod";
import { t } from "try";

const MAX_REQUEST_LENGTH = 32_000;
const endCallSchema = z.object({}).strict();
const argumentsSchema = z.object({ request: z.string().trim().min(1).max(MAX_REQUEST_LENGTH) }).strict();
export const REALTIME_TOOL_PREFIX = "realtime-tool:";

export interface RealtimeToolState {
  completed: ReadonlySet<string>;
  finishedResponses: ReadonlySet<string>;
  responseId?: string;
  pending: ReadonlyMap<string, string>;
  results: Data[];
  responseActive: boolean;
  speaking: boolean;
  awaitingSpeechResponse: boolean;
  active: boolean;
  ending: boolean;
  audioPlaying: boolean;
}

/** Create independent control state without starting media or worker work.
@returns Empty tool and response correlations.
*/
export function realtimeToolState(): RealtimeToolState {
  return {
    completed: new Set(),
    finishedResponses: new Set(),
    pending: new Map(),
    results: [],
    responseActive: false,
    speaking: false,
    awaitingSpeechResponse: false,
    active: true,
    ending: false,
    audioPlaying: false,
  };
}

/** Apply provider control events and select completed calls without executing them.
@param state - Previous session control state.
@param event - Native provider frame.
@returns New state and work descriptions for the runtime.
*/
export function receivedTools(
  state: RealtimeToolState,
  event: Data
): { state: RealtimeToolState; calls: Data[]; isCompleted: boolean } {
  switch (event.type) {
    case "output_audio_buffer.started": {
      return { state: { ...state, audioPlaying: true }, calls: [], isCompleted: false };
    }

    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared": {
      return { state: { ...state, audioPlaying: false }, calls: [], isCompleted: false };
    }

    case "input_audio_buffer.speech_started": {
      return { state: { ...state, speaking: true, awaitingSpeechResponse: true }, calls: [], isCompleted: false };
    }

    case "input_audio_buffer.speech_stopped": {
      return { state: { ...state, speaking: false }, calls: [], isCompleted: false };
    }

    case "response.created": {
      return {
        state: {
          ...state,
          responseId: string(object(event.response).id),
          responseActive: true,
          awaitingSpeechResponse: false,
        },
        calls: [],
        isCompleted: false,
      };
    }

    case "response.done": {
      const response = object(event.response);
      const id = string(response.id);

      if (state.finishedResponses.has(id) || (state.responseId && state.responseId !== id)) {
        return { state, calls: [], isCompleted: false };
      }

      const calls: Data[] = [];

      if (response.status === "completed" && Array.isArray(response.output)) {
        for (const value of response.output) {
          const call = object(value);

          if (call.type === "function_call") {
            calls.push(call);
          }
        }
      }

      return {
        state: {
          ...state,
          responseActive: true,
          responseId: undefined,
          finishedResponses: new Set([...state.finishedResponses, id]),
        },
        calls,
        isCompleted: true,
      };
    }

    default: {
      return { state, calls: [], isCompleted: false };
    }
  }
}

/** Reserve one native call before any asynchronous handoff can complete.
@param state - Previous control state.
@param sessionId - Explicit native session identity.
@param call - Completed provider function call.
@returns Deduplicated request or explicit input failure with the next state.
*/
export function requestedTool(state: RealtimeToolState, sessionId: string, call: Data) {
  const callId = string(call.call_id);

  if (!callId || !state.active || state.completed.has(callId)) {
    return { state };
  }

  const next = { ...state, completed: new Set([...state.completed, callId]) };

  if (call.name === "end_call") {
    const decoded = t(JSON.parse, string(call.arguments));
    const input = endCallSchema.safeParse(decoded.ok ? decoded.value : undefined);

    return input.success
      ? { state: { ...next, ending: true }, callId, endCall: true }
      : { state: next, callId, error: "Supply an empty object to end the voice call." };
  }

  if (call.name !== "handoff_to_pocket") {
    return { state: next, callId, error: "That tool is unavailable. No work was dispatched." };
  }

  const decoded = t(JSON.parse, string(call.arguments));
  const input = argumentsSchema.safeParse(decoded.ok ? decoded.value : undefined);

  if (!input.success) {
    return { state: next, callId, error: "Supply a nonempty request describing the work to do." };
  }

  const id = `${REALTIME_TOOL_PREFIX}${sessionId}:${callId}`;
  const pending = new Map(next.pending);

  pending.set(id, callId);

  return { state: { ...next, pending }, callId, id, request: input.data.request };
}

/** Describe one provider tool result without starting another model response.
@param callId - Original provider function identity.
@param result - Actual tool outcome.
@returns Native function output frame.
*/
export function toolOutput(callId: string, result: Data): Data {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
  };
}

/** Append a worker outcome to its original live conversation.
@param state - Previous session control state.
@param callId - Provider call awaiting the result.
@param result - Actual worker outcome or explicit uncertainty.
@returns Independent queued control state.
*/
export function queuedToolResult(state: RealtimeToolState, callId: string, result: Data): RealtimeToolState {
  return state.active
    ? {
        ...state,
        results: [...state.results, toolOutput(callId, result)],
      }
    : state;
}

/** Remove a resolved delivery correlation without changing previous state.
@param state - Previous control state.
@param id - Main-agent receipt identity.
@returns State without the resolved receipt.
*/
export function resolvedTool(state: RealtimeToolState, id: string): RealtimeToolState {
  const pending = new Map(state.pending);

  pending.delete(id);

  return { ...state, pending };
}

/** Select ready control outputs only after user and provider speech have yielded.
@param state - Explicit speech and response activity.
@returns Reserved response state and ordered wire frames; never audio data.
*/
export function flushedTools(state: RealtimeToolState) {
  return !state.active ||
    state.responseActive ||
    state.speaking ||
    state.awaitingSpeechResponse ||
    state.results.length === 0
    ? { state, events: [] }
    : {
        state: { ...state, results: [], responseActive: true },
        events: [...state.results, { type: "response.create" }],
      };
}

/** Release response ownership after every selected call has reserved its receipt.
@param state - State after synchronous dispatch setup.
@returns State ready to return queued tool outputs.
*/
export function completedToolResponse(state: RealtimeToolState): RealtimeToolState {
  return { ...state, responseActive: false };
}

/** Wait for the acknowledgement's audio playback before ending the owning call.
@param state - Current provider response and playback state.
@returns Whether the runtime should release this voice session.
*/
export function shouldEndCall(state: RealtimeToolState) {
  return state.active && state.ending && !state.audioPlaying && !state.responseActive;
}
