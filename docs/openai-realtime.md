# OpenAI realtime integration

JUA-69 replaces Codex realtime with OpenAI Realtime. This branch stages the independent provider transport, finalized transcript ledger, and handoff validation. The existing Pocket routes still use `RealtimeSession`; switching those routes and the browser requires the upstream implementations below. This draft does not claim that the replacement is enabled in the app.

## Implemented boundary

`OpenAIVoiceSession` accepts a `VoiceSessionOwner` with four functions:

| Function         | Contract                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `threadId()`     | Returns the selected main conversation's stable ID.                                                                              |
| `readKey()`      | Reads `Promise<string \| null>` when starting each session. The settings workstream owns credential storage.                     |
| `preferences()`  | Returns `{ voice, model }`. Use centralized settings when available; the documented defaults are `marin` and `gpt-realtime-2.1`. |
| `handoff(input)` | Accepts `{ id, transcript, source: { type: "realtime", sessionId, itemId } }` and returns durable delivery status.               |

The transport uses OpenAI's authenticated server-side WebSocket, PCM16 mono audio at 24 kHz, input transcription, server VAD, and speech output. It waits for `session.updated` before accepting audio. Audio and credentials are neither persisted nor sent through native Codex RPC. The endpoint argument exists for local provider fixtures; a production route must not accept an endpoint from the browser.

Only finalized speech enters the private transcript ledger. Each entry includes its provider item ID, session ID, role, exact text, and optional handoff status. Switching to text commits pending captured audio and bounds the wait for transcription. A missing final transcript produces an explicit failure. Reloading the ledger never dispatches work.

`handoff_to_pocket` accepts an item ID, not generated instructions. The server resolves that ID against the latest finalized speech in the current session. Unexpected arguments, missing speech, and stale item IDs fail closed. The main agent receives the exact stored transcript with stable receipt ID `realtime:<sessionId>:<itemId>`. The ledger records an attempt before delivery; duplicate calls reuse its result, and interrupted delivery remains uncertain rather than replaying. Text resembling XML remains ordinary transcript text.

## Integration dependencies

Settings provides `readOpenAIApiKey(): Promise<string | null>` from `src/server/pocket-settings.ts`, first pushed at `91d3647` on `codex/jua-68-settings-credentials`. That implementation is not copied into this branch. The existing per-thread realtime voice/model file must not become a second settings store; centralized voice/model preferences remain to be agreed with the settings owner.

Harness has agreed `Bridge.handoff({ id, transcript, source: { type: "realtime", sessionId, itemId } })`. It shares the durable receipt path with `send` and retains source metadata. Voice will call this method while audio is active; `Bridge.send(id, text, attachmentIds)` remains compatible for typed messages. Production wiring awaits the upstream commit implementing `handoff`. Do not invoke native turn methods or implement a second Pi entrypoint.

The browser integration must load finalized history on reload, upsert transcript events by stable item identity, display handoff status separately from user text, and clear playback on `interrupted`. Canonical main-session user messages and saved voice entries need a provenance link to avoid duplicate display. Existing legacy native history without a provenance marker must not be hidden merely because its text resembles an internal wrapper. Full browser mode-switching and reload acceptance remains pending this integration.

## Verification

Focused business flows use a local WebSocket provider and a configured dummy key. They cover audio exchange, verbatim transcript and pasted XML, durable handoff identity, duplicate suppression, rejection of generated rewrites, missing-key behavior, provider reconnect, stale-token rejection, and finalization before text mode. They do not make live OpenAI calls.

Run only these flows during development:

```sh
node --import tsx scripts/test-flows.ts tests/openai-voice-flow.test.ts --test-name-pattern='OpenAI voice'
```

Incremental ESLint and TypeScript checks accompany the changes. CI owns the full suite. Live configured-key audio verification remains unperformed because this workspace must not configure real credentials.

Protocol references: [OpenAI WebSocket connections](https://developers.openai.com/api/docs/guides/realtime-websocket), [conversation events](https://developers.openai.com/api/docs/guides/realtime-conversations), and [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).
