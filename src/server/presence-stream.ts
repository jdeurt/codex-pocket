import { type NotificationPresence } from "./notification-presence-state";
import { TextStream } from "./text-stream";

const HEARTBEAT_MS = 15_000;

/** Format one foreground challenge for its explicit stream owner.
@param stream - Native text stream.
@param challengeId - Issued challenge identity.
*/
function sendChallenge(stream: TextStream, challengeId: string) {
  stream.send(`event: probe\ndata: ${JSON.stringify({ challengeId })}\n\n`);
}

/** Connect a verified device to the foreground-presence owner.
@param presence - Process presence owner.
@param deviceId - Validated device identity.
@param stream - Native stream owner.
@returns Device subscription cleanup.
*/
function connectPresence(presence: NotificationPresence, deviceId: string, stream: TextStream) {
  stream.send(": connected\n\n");

  return presence.connect(deviceId, sendChallenge.bind(undefined, stream));
}

/** Create one request-scoped foreground challenge stream.
@param signal - Authorized request lifetime.
@param presence - Process presence owner.
@param deviceId - Validated device identity.
@returns Native SSE byte stream.
*/
export function presenceStream(signal: AbortSignal, presence: NotificationPresence, deviceId: string) {
  return new ReadableStream(new TextStream(signal, connectPresence.bind(undefined, presence, deviceId), HEARTBEAT_MS));
}
