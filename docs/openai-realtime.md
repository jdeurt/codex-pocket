# OpenAI realtime voice

Pocket uses WebRTC to stream microphone audio directly from the browser to OpenAI Realtime and stream its speech back to native browser playback. Pocket does not collect PCM, batch microphone posts, schedule audio chunks, or impose a queued-playback duration limit. The browser and provider own media buffering and interruption.

## Conversation and tools

Realtime acts and speaks as Pocket. Its dedicated instructions live in `src/server/realtime-configuration.ts`. It keeps internal routing out of ordinary conversation, answers directly only for short replies grounded in context it already has, and delegates everything else to the main Pocket agent. Requests include the last few relevant user and assistant messages, plus needed earlier decisions and constraints. It asks for clarification when intent is unclear and does not claim success before receiving a result.

Realtime has one tool: `handoff_to_pocket({ request: string })`. The main agent retains workspace tools and decides whether to delegate to other agents. A completed realtime tool call enters the existing durable main-agent outbox with a stable receipt identity. Duplicate calls cannot submit duplicate work. Cancelled responses cannot dispatch tools; uncertain delivery is reported without automatic retry.

The main agent's result returns as a `function_call_output` in the same realtime conversation. Realtime explains it naturally over its audio stream. Worker requests and answers do not appear as separate chat replies. Tool results wait for ongoing user speech or a model response to finish before requesting a continuation; audio itself does not wait on the main agent. Stopping voice revokes the connection's result destinations without cancelling already accepted main-agent work.

## Connections and lifecycle

The browser creates a peer connection and microphone track, then submits its SDP offer to Pocket. The server calls OpenAI's `/v1/realtime/calls` endpoint with server-held credentials and session settings. It attaches a server WebSocket using the returned call ID, confirms session configuration, and returns the SDP answer. This sideband connection handles tools and text events only. The browser's data channel carries provider controls, never an application PCM playback queue.

Automatic semantic-VAD responses and interruption are enabled. Pocket does not wait for a speech transcript before letting the model respond. Microphone loss, peer failure, or loss of the server control connection ends the owned call. Stop releases local media immediately, revokes controls, and requests provider hangup. A stale token cannot stop a newer call. Unsaved composer text and attachments remain intact.

The independent `/api/realtime/events` feed carries captions and status. Losing that observer reports a text-feed error without stopping media. Caption and storage failures likewise report a warning while speech continues. Only development fixtures may select a loopback provider; production uses OpenAI.

## Captions and continuity

Input transcription is explicitly enabled in the OpenAI session with `gpt-4o-transcribe`. Those asynchronous events populate user bubbles; the realtime output audio transcript populates assistant bubbles. Neither transcription nor saving captions gates audio, response creation, or tools. Input captions are a transcription of the audio, not the input the realtime model understands. They can arrive late or be imperfect.

Finalized captions are saved separately with role, provider identity, and predecessor anchors. Audio is not persisted or logged. The old transcript-to-agent delivery barrier and **Send saved speech** action are removed. Existing uncertain-delivery records retain their notice.

At startup, realtime receives bounded recent conversation text, saved voice captions, and main-agent activity/queued work as historical context. No additional summarization model call is made. This is not a copy of the main agent's complete internal or tool history; realtime asks the main agent when that missing context matters.

When typing resumes after voice stops, finalized caption writes are joined and newly saved voice conversation is attached to the next typed request as background context. The model-facing envelope explicitly grants no new user authorization and tells the agent not to repeat completed work. Durable receipt watermarks avoid reattaching the same captions; the UI retains the original typed message. Failed or unfinished captions cannot be recovered as exact history. Context text is bounded to 48,000 characters per handoff direction.

## Focused verification

Node workflows exercise actual SDP HTTP negotiation, the server control connection, real main-agent bridge delivery, duplicate/cancelled tool handling, revoked tokens, history, context in both directions, and blocked persistence. The provider is a loopback protocol fixture with synthetic credentials.

Browser workflows use native browser peer connections, microphone capture, and generated remote audio. They check bidirectional RTP across the old eight-second limit while captions arrive late, draft/attachment retention, permission failures, disconnect cleanup, text continuation, and absence of duplicate worker replies. The provider controls and speech captions are synthetic; these checks do not prove live OpenAI speech understanding, real VAD timing, phone speaker behavior, or network quality.

Run only selected named cases locally; CI owns the full suite and browser matrix. No live credentials or paid provider calls are used by these fixtures.

References: [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), [server controls](https://developers.openai.com/api/docs/guides/realtime-server-controls), [conversations and tools](https://developers.openai.com/api/docs/guides/realtime-conversations), and [VAD](https://developers.openai.com/api/docs/guides/realtime-vad).
