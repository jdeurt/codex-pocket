# OpenAI realtime voice

Pocket streams mono PCM16 at 24 kHz from the browser through its server to OpenAI Realtime. The server owns the provider WebSocket and credentials. Browser capture and playback have one lifecycle owner, and provider events have one serial persistence/delivery owner. Production uses OpenAI; only the development fixture can select a loopback provider.

## Turn ownership

Semantic VAD with low eagerness gives unfinished phrases and fillers time to complete. Automatic provider responses are disabled: Pocket waits for the committed speech items' final transcripts before requesting a response. This is a transcript barrier, not an audio buffer. Microphone audio continues streaming while transcription, main-agent work, or output playback runs.

`VoiceTurns` tracks speech identities in provider order, independently of transcription completion order. A response owns an immutable ordered list of speech items and a unique key echoed through provider response metadata. A later final, including “Um”, cannot replace its input. The handoff tool has no arguments: the host already owns the response identity, so the model never has to copy opaque item IDs or choose source text. Unexpected tool arguments remain a hard error. Duplicate or stale response completions cannot execute another turn's tool call. Output is accepted only for the active provider response; barge-in stops browser playback, suppresses late output, and sends the played duration through `conversation.item.truncate`.

Cancelled responses cannot dispatch tools. Their saved speech remains available and joins the next completed utterance, preserving the original words and any correction. A completed multi-segment handoff sends those exact segments joined by newlines. Known filler-only input cannot dispatch. The model is instructed to clarify unfinished requests and emit only the handoff tool call when delegating, without claiming acceptance before a tool result.

The old “latest finalized item” check was incorrect: an asynchronous final from a different speech item could invalidate a legitimate in-flight response. Response ownership replaces that mutable global check; strict argument validation and immutable saved transcripts remain.

## Main-agent answer playback

An accepted handoff retains its durable receipt in the active voice connection. When the Bridge receives the main turn's completion, it returns the final assistant text to the receipt on that turn's latest user input. Queued work uses the same path once its own turn completes. An answer that arrives before the handoff acknowledgment waits behind the existing delivery and persistence barrier.

Voice requests an audio response with that actual answer as its only input and tools disabled. It reads the answer aloud without substituting a delivery acknowledgment or repeating the main-agent work. PCM chunks stream through the existing playback path. The canonical main answer remains the transcript row; its spoken rendition does not add a second copy to saved voice history. Immediate conversational replies still use the ordinary speech response path.

Each accepted receipt can trigger playback once. New speech invalidates pending answers and interrupts any current playback. Late audio and response completions remain subject to the active response identity. Stopping or restarting voice cannot replay an earlier connection's answers, and unrelated main turns cannot trigger playback.

## Delivery and recovery

`VoiceHistory` saves finalized text, explicit role, provider identity, predecessor anchor, and handoff receipt/status in private host storage. Audio is neither persisted nor logged. A grouped turn uses one durable receipt shared by all its segments. The main outbox checks the receipt's content and source before accepting a retry.

The ledger records `sending` before dispatch. Duplicate calls return the saved result. A lost dispatch acknowledgment becomes `unknown`; restart also treats an unfinished attempt as unknown. Pocket never automatically replays an uncertain action. Routine voice-origin and successful-delivery badges are hidden; provenance and delivery status remain in the ledger. Uncertain delivery retains its visible notice.

Provider/configuration failures release capture and output. Missing transcription and response completion have bounded deadlines. Starting again creates fresh ownership and never reuses a previous microphone token. On normal stop, Pocket drains captured input, waits a bounded time for final speech, then closes the provider. History refresh runs even if stop finalization fails, so saved text remains available.

Unsent finalized user speech has a **Send saved speech** action. Stop voice first, review the saved text, then send it explicitly. This uses the original receipt and serialized delivery path. It neither edits the draft nor consumes its attachments. Uncertain attempts display a check-before-retrying notice and have no resend action. Unfinalized audio cannot be reconstructed after a disconnect; the error remains visible so the user can finish or repeat it deliberately.

## One transcript

Main and voice messages share the virtualized transcript. Saved voice messages carry predecessor item IDs observed when speech begins or commits. The renderer inserts them at those anchors, preserving provider speech order even when final transcripts arrive in another order. Main messages retain their native order. Receipt identity reconciles voice handoffs with canonical main messages; equal text never implies duplication.

This replaces the old layout that rendered every main turn first and every voice entry afterward. A typed or spoken follow-up and its response now follow earlier voice activity. Legacy speech without anchors retains its saved order at the tail because its original position cannot be recovered reliably from timestamps.

Pi projects accepted steering text immediately, before its current tool finishes. Later native user events update the original receipt in its original turn, including after cancellation and continuation. They do not erase the accepted follow-up while waiting for native consumption.

## Verification

Provider-boundary business flows use real local WebSockets and private history/outbox persistence. They cover the reported filler race, reordered final transcripts, partial events, grouped speech, duplicate completions, repeated identical requests, strict arguments, cancellation, disconnect, stop finalization, and uncertain delivery. Answer-playback flows verify exact main-answer input, conversational and delegated PCM streaming, an answer arriving before the dispatch acknowledgment, interruption, truncation, and stale-result suppression across newer speech and session restarts. Browser flows use the real app and local provider with dummy credentials. They exercise failed handoff followed by text, explicit recovery, reload, spoken interruption, audio playback truncation, and draft/attachment cleanup. The handoff browser flow also checks that the canonical answer reaches the provider and nonzero decoded PCM completes playback without a duplicate transcript row. The real Pi-session integration uses an offline provider and actual tools to verify accepted steering visibility.

Run only named cases locally. CI owns full-suite validation and Chromium/WebKit coverage. These fixtures verify application/protocol behavior; they do not validate live OpenAI turn detection, microphone accuracy, device echo, or network performance. No live credentials or paid calls are needed for this suite.

Protocol references: [Realtime conversations and function results](https://developers.openai.com/api/docs/guides/realtime-conversations), [semantic VAD](https://developers.openai.com/api/docs/guides/realtime-vad), and [WebSocket transport](https://developers.openai.com/api/docs/guides/realtime-websocket). WebSocket playback requires explicit client truncation; WebRTC would move playback ownership to the provider but also replace the existing authenticated transport and device integration. This change retains the supported transport and simplifies its turn and playback ownership.
