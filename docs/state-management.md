# State management

Pocket uses Zustand vanilla stores for shared observable state. React subscribes through thin hooks; services own network requests, browser resources and persistence effects.

| Location                         | Responsibility                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/state/`                     | State types, store factories, reconciliation and persisted subsets. No React or browser/database access.           |
| `src/services/`                  | API requests, SSE, uploads, WebRTC, notifications and browser storage adapters. Services coordinate store updates. |
| `src/providers/pocket-state.tsx` | One client and its stores per rendered Pocket; starts and disposes services after hydration.                       |
| `src/hooks/`                     | Selectors and subscription lifetimes connecting stores to React.                                                   |
| `src/components/`                | Rendering and local interaction state, such as open menus, unsaved settings fields, focus and layout measurements. |
| `src/server/`                    | Authorized bootstrap reads and host persistence adapters, including SQLite.                                        |

## Scope and hydration

`readClientBootstrap` loads the selected Pocket's durable catalog, public settings and saved voice captions for each authorized server render. It supplies the same serialized seed to server rendering and client hydration. The native conversation then arrives through the existing snapshot SSE connection. Settings secrets are excluded from the seed.

`PocketStateProvider` constructs a fresh client with `createPocketClient(initial)`. There is no module-global Zustand store. Changing Pocket identity remounts the provider, keeping drafts, optimistic delivery, resource caches and voice lifecycle separate. Resources within one provider share a reference-counted subscription per URL; late responses from disposed subscriptions cannot update it.

Browser draft stores use Zustand `persist` with `skipHydration`. Storage reads start after mount. A revision check preserves text entered while an asynchronous hydration is pending. The browser adapter preserves the existing plain-text localStorage keys (`codex-pocket-draft` and `codex-pocket-draft:<id>`), including synchronization across tabs. Attachment files and pending delivery receipts remain in the existing IndexedDB storage.

## Durable server state

Finalized voice captions use a vanilla Zustand store with an injected SQLite `PersistStorage` adapter. The database is `<localDirectory>/voice-history.sqlite` (normally `~/.pocket/data/voice-history.sqlite`). Keys are SHA-256 hashes of native thread IDs. The adapter validates the versioned persisted subset and atomically replaces each key. Only captions are persisted; actions, media, connection status and pending requests are excluded.

If SQLite has no entry, the adapter reads the existing `voice-history/<hash>.json` ledger. The next successful caption write saves the combined history to SQLite. Legacy files remain unchanged; an older release will therefore see only its legacy history, not captions added after migration. Unsupported persisted versions fail hydration without overwriting storage.

SQLite remains server-owned. Zustand is the in-process state interface, not a database or synchronization protocol. Browser updates still cross validated APIs and event streams. Canonical native conversation state and Pocket configuration keep their existing server owners.

## Conversation and voice

The thread store reconciles optimistic messages by their durable client IDs when canonical snapshots arrive. The delivery service owns submit locks, retry identity and uncertain-delivery recovery. Settings, Pocket mutations and approval responses share a guarded operation runner; form values remain local.

The voice store exposes lifecycle status, errors and captions. Peer connections, microphone tracks, analysers and control subscriptions stay private to the voice service. Audio streams over WebRTC independently of caption events and persistence. A caption read or storage failure cannot gate audio playback. Saved final captions win over delayed partial captions.

## Adding state

Create a vanilla factory in `src/state` when state must survive component remounts or coordinate multiple views. Put effects in an injectable service, expose its actions through the scoped client, and subscribe with `useStore` selectors. Keep presentation-only state in the component. Persist only the durable subset, validate reads, version the stored shape, and explicitly define hydration and migration behavior. Never put a user's store in a server module singleton.

## Refactor checks

JSCPD identified repeated mutation error/finally handling in Pocket editing and approval submission; those now use the shared operation service. Resource polling and its lifecycle also have one service owner. Similar import blocks, JSX and paired listener registration/cleanup are retained where an abstraction would obscure ownership.

With the repository's normal JSCPD configuration, the old hooks/components/lib scope reported 49 duplicate pairs and 865 duplicated lines (8.32%). Including the extracted state/services/provider modules after refactoring reports 57 pairs and 943 lines (8.66%). At the more sensitive 30-token/4-line threshold, the corresponding UI/state scope changed from 26.96% to 26.32%. These scans guide review; they do not demonstrate an overall reduction in duplication.

Focused workflow tests cover store isolation, optimistic reconciliation, asynchronous hydration, SQLite reopening, legacy migration and incompatible versions. Browser checks cover Pocket switching, draft restoration, settings synchronization, retry identity, attachments, Side Pockets and direct realtime media. CI owns full-suite validation.
