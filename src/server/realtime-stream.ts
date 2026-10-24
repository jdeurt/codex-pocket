import { type RealtimeSession } from "./realtime-session";
import { TextStream } from "./text-stream";

/** Deliver provider metadata while rejecting events from a replaced call.
@param realtime - Selected Pocket's call owner.
@param token - Authorized call token.
@param stream - Request-scoped text stream.
@param event - Native metadata event.
*/
function realtimeMessage(realtime: RealtimeSession, token: string, stream: TextStream, event: Event) {
  if (!(event instanceof CustomEvent)) {
    return;
  }

  stream.send(JSON.stringify(event.detail) + "\n");

  if (!realtime.owns(token)) {
    stream.close();
  }
}

/** Remove the exact metadata callback registered for one consumer.
@param realtime - Selected call owner.
@param listener - Registered native callback.
*/
function disconnectRealtime(realtime: RealtimeSession, listener: (event: Event) => void) {
  realtime.removeEventListener("message", listener);
}

/** Send current metadata and subscribe without taking ownership of audio.
@param realtime - Selected Pocket's call owner.
@param token - Authorized call token.
@param stream - Request-scoped native stream.
@returns Metadata subscription cleanup.
*/
function connectRealtime(realtime: RealtimeSession, token: string, stream: TextStream) {
  stream.send(JSON.stringify(realtime.status()) + "\n");

  for (const caption of realtime.liveCaptions()) {
    stream.send(JSON.stringify(caption) + "\n");
  }

  const listener = realtimeMessage.bind(undefined, realtime, token, stream);

  realtime.addEventListener("message", listener);

  return disconnectRealtime.bind(undefined, realtime, listener);
}

/** Create an authorized metadata stream with request-scoped teardown.
@param signal - Owning HTTP request.
@param realtime - Selected Pocket's call owner.
@param token - Authorized call identity.
@returns Native newline-delimited metadata stream.
*/
export function realtimeStream(signal: AbortSignal, realtime: RealtimeSession, token: string) {
  return new ReadableStream(new TextStream(signal, connectRealtime.bind(undefined, realtime, token)));
}
