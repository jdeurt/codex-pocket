# State management

Pocket uses Zustand vanilla stores for shared observable state. React subscribes through thin hooks; services own network requests, browser resources and persistence effects.

| Location                         | Responsibility                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/state/`                     | Pure state types, selectors, transitions and persisted subsets. No React or browser/database access.               |
| `src/runtime/`                   | Zustand stores, persistence hydration, React lifecycle bindings and native resource owners.                        |
| `src/services/`                  | API requests, SSE, uploads, WebRTC, notifications and browser storage adapters. Services coordinate store updates. |
| `src/providers/pocket-state.tsx` | One client and its stores per rendered Pocket; starts and disposes services after hydration.                       |
| `src/hooks/`                     | Selectors and subscription lifetimes connecting stores to React.                                                   |
| `src/components/`                | Rendering and local interaction state, such as open menus, unsaved settings fields, focus and layout measurements. |
| `src/server/`                    | Authorized bootstrap reads and host persistence adapters, including SQLite.                                        |

## Scope and hydration

`readClientBootstrap` loads the selected Pocket's durable catalog, public settings and saved voice captions for each authorized server render. It supplies the same serialized seed to server rendering and client hydration. The native conversation then arrives through the existing snapshot SSE connection. Settings secrets are excluded from the seed.

`PocketStateProvider` constructs a fresh client with `new PocketClient(initial)`. There is no module-global Zustand store. Changing Pocket identity remounts the provider, keeping drafts, optimistic delivery, resource caches and voice lifecycle separate. Resources within one provider share a reference-counted subscription per URL; late responses from disposed subscriptions cannot update it.

Browser draft stores use Zustand `persist` with `skipHydration`. Storage reads start after mount. A revision check preserves text entered while an asynchronous hydration is pending. The browser adapter preserves the existing plain-text localStorage keys (`codex-pocket-draft` and `codex-pocket-draft:<id>`), including synchronization across tabs. Attachment files and pending delivery receipts remain in the existing IndexedDB storage.

## Durable server state

Finalized voice captions use a vanilla Zustand store with an injected SQLite `PersistStorage` adapter. The database is `<localDirectory>/voice-history.sqlite` (normally `~/.pocket/data/voice-history.sqlite`). Keys are SHA-256 hashes of native thread IDs. The adapter validates the versioned persisted subset and atomically replaces each key. Only captions are persisted; actions, media, connection status and pending requests are excluded.

If SQLite has no entry, the adapter reads the existing `voice-history/<hash>.json` ledger. The next successful caption write saves the combined history to SQLite. Legacy files remain unchanged; an older release will therefore see only its legacy history, not captions added after migration. Unsupported persisted versions fail hydration without overwriting storage.

SQLite remains server-owned. Zustand is the in-process state interface, not a database or synchronization protocol. Browser updates still cross validated APIs and event streams. Bridge snapshots and the Pi history projection use per-owner Zustand stores. Native events and receipts produce new snapshots; background reads return new records instead of modifying catalog records held by another request. Pocket configuration retains its existing durable server owner.

## Conversation and voice

The thread store reconciles optimistic messages by their durable client IDs when canonical snapshots arrive. The delivery service owns submit locks, retry identity and uncertain-delivery recovery. Settings, Pocket mutations and approval responses share a guarded operation runner; form values remain local.

The voice store exposes lifecycle status, errors and captions. Peer connections, microphone tracks, analysers and control subscriptions stay private to the voice service. Audio streams over WebRTC independently of caption events and persistence. A caption read or storage failure cannot gate audio playback. Saved final captions win over delayed partial captions.

## Adding state

Define pure state and transitions in `src/state` when data must survive component remounts or coordinate multiple views. Allocate its Zustand store in `src/runtime`. Put API and resource effects in a scoped runtime or service owner, expose its actions through the client, and subscribe with `useStore` selectors. Keep presentation-only state in the component. Persist only the durable subset, validate reads, version the stored shape, and explicitly define hydration and migration behavior. Never put a user's store in a server module singleton.

## Refactor checks

JSCPD guides consolidation across the authored `src` tree. Shared operation handling, serial execution, native text streams, optional-file reads and static UI slots now have explicit reusable implementations. The app-wide cleanup is still in progress; remaining native adapters are being checked for captured state, input mutation and lost failures. A nested-function count alone does not establish purity.

At the current checkpoint, the unchanged JSCPD configuration reports 128 clone pairs and 1,634 duplicated lines across 38,738 source lines (4.22%). The pre-cleanup baseline was 150 pairs and 2,012 duplicated lines across 33,307 lines (6.04%). Both the duplicate count and duplicated-line count decreased; total source size increased during boundary extraction.

Application logic receives explicit state, time, identities and configuration. Function implementations belong at module scope; framework callbacks bind explicit arguments or native resource owners. The exception for effects covers actual I/O, resource lifetimes and observable publication, not arbitrary business logic inside a service class. ESLint rules remain enabled; the migration does not add suppressions.

Operations use `await` and the `try` package’s Results at fallible calls. They perform cleanup after the operation settles and then propagate any unhandled failure. If work and cleanup both fail, both errors survive in an aggregate. Native shutdown joins inspect every settled result. Background boundaries report failures explicitly. Forwarding functions and async IIFEs are removed; ESLint rejects `try` statements, async IIFEs, and `.then()`, `.catch()` and `.finally()` members, and requires `unicorn/prefer-await`. Attachment serialization finishes before IndexedDB opens, then the transaction owner closes the database. Mutation controllers publish settled state once. `SerialQueue` reserves operation order while allowing later work to recover from an earlier caller’s failure. The shared HTTP endpoint boundary translates handler Results into the existing response policy. Realtime test providers share multipart parsing and HTTP failure handling.

Focused workflow tests cover store isolation, optimistic reconciliation, asynchronous hydration, SQLite reopening, legacy migration and incompatible versions. Browser checks cover Pocket switching, draft restoration, settings synchronization, retry identity, attachments, Side Pockets and direct realtime media. CI owns full-suite validation.
