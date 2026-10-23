# OpenAI realtime voice

Pocket uses OpenAI Realtime for microphone input and spoken responses. An OpenAI API key must be configured in central Settings. The key stays on the server, and each new voice session reads the current key, voice, and model preferences. No native Codex realtime methods are called.

## Speech and handoffs

The browser sends bounded PCM16 mono audio at 24 kHz to its selected Pocket. `OpenAIRealtime` owns the authenticated provider WebSocket and waits for `session.updated` before accepting microphone input. Production connects to OpenAI; the development fixture can select only an explicit loopback WebSocket endpoint. The browser cannot select a provider endpoint or obtain the key.

`OpenAIVoiceSession` stores finalized speech in private host storage before displaying it or permitting a handoff. Entries include the exact transcript, provider item ID, session ID, role, and optional delivery status. Audio is not persisted or logged. Stable entry IDs prevent duplicate display when events repeat or history reloads.

The voice model can call only `handoff_to_pocket({ item_id })`. The server resolves that ID against the latest finalized user speech in the current session. Missing speech, stale item IDs, extra instructions, and changed final transcripts fail closed. The main session receives the saved transcript unchanged through `Bridge.handoff`, with receipt ID `realtime:<sessionId>:<itemId>` and explicit source metadata. Generated tool instructions do not become user messages.

The handoff ledger records an attempt before dispatch, and the main outbox verifies the receipt's content and source on retries. Duplicate tool calls reuse the existing result. Interrupted delivery becomes uncertain after reload and is never replayed automatically. The browser uses canonical receipt identity (`id` for Pi and `clientId` for Codex) to omit a duplicate voice copy once the main conversation or queue owns visible user text. An empty canonical item does not hide finalized speech while its text is still hydrating. It does not infer provenance from XML text. Intentionally pasted XML stays visible; historical native messages without provenance are not silently reclassified by their contents.

Stopping voice drains captured input and bounds the wait for a finalized transcript. Missing final speech produces a visible error. Finalized speech and the unsent text draft survive mode switching and page reload. A speech-start event clears queued playback. Microphone tracks are released on stop, permission cancellation, input loss, provider failure, and Pocket switching.

## Shared interfaces

Settings dependency: `f09c33e` on `codex/jua-68-settings-credentials`.

- `readOpenAIApiKey(): Promise<string | null>` in `src/server/pocket-settings.ts` resolves the server-only credential.
- `readPocketSettings()` exposes nullable `realtimeVoice` and `realtimeModel` overrides. Null selects Voice's provider defaults, `marin` and `gpt-realtime-2.1`.
- `updatePocketSettings()` owns partial preference updates. The previous per-thread realtime preference files are no longer read or written.

Harness dependency: `1bd0467` on `codex/jua-67-jua-71-pi-context`, including the agreed source-aware handoff interface.

```ts
Bridge.handoff({
  id,
  transcript,
  source: { type: "realtime", sessionId, itemId },
}): Promise<{ id: string; status: string }>
```

`handoff` shares the durable receipt path with `send`. Voice validates returned delivery statuses, preserves uncertain outcomes, and leaves main-runtime ownership with the harness workstream. Both dependency histories are integrated into this branch. The Pi runtime is inherited unchanged from the harness workstream; voice commits implement the provider connection, history, and handoff consumer.

## Verification

Local WebSocket business flows cover exact speech and pasted XML, audio exchange, strict handoff arguments, stale-item rejection, duplicate suppression, provider recovery, stop-time finalization, private configuration failures, and uncertain delivery after reload. Browser flows exercise the real app, central Settings, local provider, and durable main-session outbox with a dummy key.

The realtime browser collection retains gesture activation/cancellation, microphone cleanup, draft/attachment preservation, Pocket isolation, backpressure, reconnect, and active-tool steering coverage. Native Codex close-acknowledgment and media-RPC cases have been replaced with OpenAI token isolation, transcription deadlines, and source-aware handoff/reload flows.

Run only relevant named cases during development, for example:

```sh
node --import tsx scripts/test-flows.ts tests/openai-voice-flow.test.ts --test-name-pattern='OpenAI voice'
npx playwright test --config=playwright.realtime.config.ts --project=realtime-chromium-phone --grep 'configured OpenAI voice hands off'
```

CI owns full-suite validation. Live OpenAI audio verification remains unperformed because this workspace must not configure real credentials.

Protocol references: [WebSocket connections](https://developers.openai.com/api/docs/guides/realtime-websocket), [conversation events](https://developers.openai.com/api/docs/guides/realtime-conversations), and [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).
