# OpenAI live voice

Pocket uses GPT-Live 1 with direct browser-to-OpenAI WebRTC audio. The default model is `gpt-live-1`, the default voice is `marin`, and conversational timing uses OpenAI’s defaults. There is no application VAD timeout, transcript-to-response barrier, PCM batching, or queued playback limit. Explicit compatible model and voice choices apply to the next call. Recognized saved model aliases from the retired Realtime API resolve to the Live default; arbitrary custom model identifiers remain explicit overrides and OpenAI validates them at creation.

## Identity and backend delegation

The instructions in `src/state/realtime-configuration.ts` make the voice speak as Pocket. It uses “I,” keeps internal delegation private, says “I’m looking into it. Give me a moment.” when requesting work, and can say “I’m still looking into it.” when asked for progress. It reports verified results and does not invent progress. The prompt includes GPT-Live’s backchannel, interruption, and delegation policies and the native `<|SpawnThinking|>` trigger.

Sessions use `delegation: { type: "client" }`. A `session.delegation.created` event contains a delegation identity and media offset, not function arguments or task text. Pocket reserves each identity before asynchronous work. Once some current-call user text is available, it sends the existing main-agent outbox a context packet containing observed speech, historical context, and the delegation offset. Observed fragments may be incomplete; the main agent must inspect the live conversation through `pocket_realtime_inspect` or clarify before acting on missing instructions. Historical startup text alone cannot trigger new work. Duplicate delegation identities cannot submit duplicate work.

Verified backend results return through `session.commentary.append` with the original `delegation_id`, a unique command `event_id`, and content chunks capped at 400 UTF-8 bytes, conservatively below the provider’s 500-token limit. A context acknowledgment means acceptance, not completed playback. Pocket sends no `response.create` and does not wait for silence or a nonexistent per-response completion event. The Live model decides when to use the result. Internal backend requests and replies stay out of the public chat. Ending voice revokes its result destinations while accepted main-agent work continues.

## Negotiation and shutdown

The browser registers its data channel, captures a native microphone track, and fully gathers ICE candidates before submitting SDP. The server creates a session through JSON `POST /v1/live/sessions`, supplying immutable startup instructions, audio settings, optional historical input, and `transport: { type: "webrtc", sdp }`. It preserves the returned opaque session ID and attaches `wss://api.openai.com/v1/live/sessions/{id}/attach` using the same private project credential. Attachment joins an already running session: Pocket sends no second startup or session-settings command.

Media flows directly over WebRTC. The sideband handles metadata and backend context. Reflected audio events are discarded immediately without decoding their audio, persistence, or logging. The independent `/api/realtime/events` observer carries UI captions and status. Caption rendering, storage, and diagnostics do not gate playback. Captions can appear before sound reaches the speaker because audio buffering and text delivery are independent.

When the user asks to hang up, the voice acknowledges and requests backend help. The main Pocket calls `pocket_realtime_end({ sessionId })` with the local identity from delegation context or inspection. A request to stop speaking does not end a call or cancel work. Both the backend tool and the browser stop control use the same voice-only lifecycle. Stale browser tokens and stale local session IDs cannot end a replacement call.

Stopping immediately mutes the microphone and speaker, displays an “Ending call…” spinner, and turns all spectrum bars gray. The peer connection, data channel, and server sideband remain available until `session.closed` provides final usage. Only then are transports released. Shutdown has a bounded deadline; missing finalization is reported explicitly, with an emergency provider hangup attempted. There is no claim that a spoken goodbye has finished acoustically. Chat history, composer drafts, attachments, and accepted main-agent work survive hangup.

Microphone loss, peer failure, and sideband loss release the owned call. Caption-observer or persistence failure reports a warning independently of media. Only development fixtures may select a loopback provider; production uses OpenAI.

## Transcript and display state

Native `session.input_transcript.delta` and `session.output_transcript.delta` events carry immutable text fragments, event IDs, and `start_ms`/`end_ms`. GPT-Live provides no transcript turn IDs or turn-complete event. Pocket preserves exact spaces, repeated words, timestamps, and identities rather than inventing a final utterance or waiting to display one. The existing internal `transcriptDone`/`done` fields describe an immutable observed fragment, not a finished spoken turn.

Pure state transitions group fragments into speaker bubbles using media gaps and speaker boundaries. Both speakers can grow independently during overlap. Fragments and groups are ordered by media time within their call, so late input captions can appear before output captions that arrived earlier. Grouping never delays audio. Canonical transcript lookup occurs only when a new display group needs its insertion boundary.

The shared native/voice timeline projects timestamp-ordered groups into predecessor chains and includes durable restart notices in those dependencies. This keeps “Pocket restarted” at the boundary where it happened, including after reconnect and reload. A vanilla Zustand store owns live captions and another owns client-delegation reservations; pure transitions make their decisions. Media resources remain in runtime owners. See [state management](state-management.md).

Immutable fragments persist through an independent serial queue into `voice-history.sqlite`, with roles, local call identity, provider event identity, group identity, timestamps, and canonical anchors. Raw audio is not persisted or logged. Legacy finalized-caption records and JSON ledgers remain readable; the next successful write migrates legacy thread data to SQLite. Previously saved finalized text cannot be rewritten. Legacy uncertain-delivery notices remain visible.

Startup input contains bounded recent public conversation and main-agent activity as historical context, without an extra summarization model call. It does not copy the main agent’s full internal history. When typing resumes, queued fragment writes are joined and newly saved voice conversation is attached as background context, ordered through the same display projection. Durable watermarks prevent repeated attachment; the public typed message remains unchanged. Missing speech fragments cannot be recovered as exact history.

The transcript’s follow preference lives in the shared Zustand store. New native replies and growing voice groups follow the bottom when that preference is enabled, including late row-size changes. Scrolling up disables follow and preserves the reading anchor; jumping to the latest message enables it again.

The spectrum uses fixed 4.5px bars and 4px gaps. It rounds the count down to fit available width, including after resize and with reduced motion. Its canvas backing store changes only when dimensions change.

## Diagnostics and verification

The provider data channel feeds content-free `realtime.response_timing` diagnostics. A call-local Zustand projection records transcript receipt times and native media offsets. It emits one sample per approximate output group, with optional input-caption-to-output-caption receipt duration and media gap. Overlap can produce a negative media gap. Native receiver packet counters, cumulative average jitter-buffer delay, and audio-element/context state are read asynchronously. Speech text, audio, credentials, network addresses, and backend arguments never enter these records.

These observations describe transcript receipt and media timing, not the exact moment speech ends or sound becomes audible. They cannot establish a device’s acoustic response latency. Live OpenAI calls and physical-phone measurements are needed to identify a particular audible pause.

Focused Node workflows exercise JSON session creation, authenticated sideband attachment without a second startup, delegation deduplication, bounded commentary results, blocked persistence, overlapping/late fragments, typed continuity, restart order, graceful finalization, and stale-owner rejection. Browser fixtures use native microphone capture and WebRTC peers with synthetic provider metadata. CI owns the full suite and browser matrix. Fixtures use synthetic credentials and make no paid provider calls; they do not prove live speech understanding or phone speaker behavior.

References: [GPT-Live](https://developers.openai.com/api/docs/guides/live), [migration](https://developers.openai.com/api/docs/guides/live-migration), [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [delegation](https://developers.openai.com/api/docs/guides/live-delegation), and [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).
