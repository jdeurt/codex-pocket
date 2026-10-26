# Pi main sessions and exact task context

Main Pocket sessions now run the pinned `@earendil-works/pi-coding-agent` SDK in an owned host subprocess. Native Codex remains a migration/history reader and the Codex delegation harness. Claude delegation retains its existing adapter. Pocket keeps its original parent identity, durable outbox, Bridge snapshots, schedule delivery, and report originals.

This work depends on JUA-68's central settings implementation (`src/server/pocket-settings.ts`, `readOpenAIApiKey(): Promise<string | null>`). Pi receives the selected key through an in-memory credential store. It does not write another credential file or configure provider access. A missing key produces a Settings instruction before a provider request is attempted. Existing Pi provider sessions retain their key until reconnect.

## Execution boundary and legacy configuration

Pi main tools and the Pocket MCP connection run within the host process's existing machine and environment permissions. Pocket does not rely on harness-level sandboxing. Codex `read-only`, `workspace-write`, `danger-full-access` and approval settings are not enforced by Pi and do not gate the migration. No OS or environment security settings are changed.

`CODEX_SERVER_ARGS` and native Codex permission settings still configure native delegation and legacy conversation bootstrap/history access. Codex children inherit that native profile; Claude retains its existing supported native permission mapping. They are not security controls for the Pi main session. Session inspection reports this boundary explicitly instead of presenting a restrictive Codex profile as Pi enforcement.

Existing active Codex main work must finish before migration to avoid duplicating an in-progress task. Missing provider credentials and unavailable native history remain actionable setup errors, independently of sandbox parity.

Pi's [isolation documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/containerization.md) describes optional whole-process and tool-isolation deployments. This migration does not install or require them, change machine security, or create persistent access.

The offline Codex protocol/browser fixtures explicitly select their Node replay transport with `POCKET_TEST_MAIN_HARNESS=codex`; this is accepted only when the configured binary is this Node executable. Production/native Codex binaries do not activate the replay path. The Pi business flow exercises the actual SDK with Pi's faux provider, not a model API call.

## Tools, models and native history

Pi exposes its built-in tools, preserves structured phone questions through a native-cancellable `request_user_input` compatibility tool, delivers readable reports and Markdown links directly through the parent-only `pocket_send_to_chat` tool, and connects the same parent-scoped Pocket MCP server for scheduling, Side Pockets, adoption, spinner and session tools. Project instruction and skill discovery remain native Pi behavior. Executable project extensions are not auto-trusted. The effective existing developer instructions are composed with Pocket's main prompt.

`pocket_session_models` lists Pi catalog selections. Main model settings resolve `provider/model` identities through that catalog; bare IDs select OpenAI. Unsupported names fail explicitly. Settings apply to subsequent turns and persist separately per parent. Native delegates retain the host's native Codex model/effort defaults, with explicit per-child overrides still available. Arbitrary Pi provider/model IDs or thinking levels are not passed into native Codex/Claude configuration. Claude keeps its own model selection and permission checks.

On first migration, complete Codex history is saved as `legacy-codex.md` for silent retrieval and copied into a Pi custom context entry without executing it again, and its original phone transcript IDs are retained. New exact Pi source and the phone projection are private durable files. Interrupted Pi work is marked interrupted on restore; accepted or uncertain submissions are never replayed as fresh user input. Existing Pocket restart recovery remains separate.

## Task provenance and lifecycle

The single task subsystem lives in `src/tasks/`; see [Task management architecture](task-management.md) for ownership, invariants, and migration rules. Receipt acceptance allocates a stable request identity before interpretation. Pi retains exact native binding metadata, application-owned run/request origins, and call relationships. Delegate commands inherit per-command origins, so late reports and reused Side Pockets do not depend on the latest task or prose similarity.

Private `tasks/<parent-hash>/ledger.sqlite` atomically records events, membership, routing decisions, lifecycle changes, correlations, and ingestion checkpoints. Exact native records remain immutable under `source/<sequence>.json`; retries reuse an original saved before an interrupted checkpoint commit. Generated task Markdown contains original intent, summaries, pending questions, assignments, work/retention/delivery state, timeline previews, and exact source references. A separate chronological projection provides broader context.

An idle-session timer runs approximately every ten minutes. New user input preempts interpretation. Application-owned relationships route first; missing correlation remains unresolved. Semantic interpretation uses current intent and bounded task descriptions, including archived work. Unrelated requests do not close work. Explicit work changes require supporting event references, and actual chat-delivery evidence is independent of model completion.

Native compaction uses a separate protected-context planner. Every model call receives pending work, constraints, questions, unresolved requests, and command identities. Compaction is refused if this protected context exceeds its budget. Oversized packets remain in the ledger while the model receives bounded navigation to paged task inspection. Historical memberships are retained as legacy decisions, and reclassification produces a reviewable proposal without replaying requests or delegate assignments.

### Local earlier-task search

`pocket_task_search` now uses the pinned [`@tobilu/qmd` 2.8.3 SDK](https://github.com/tobi/qmd/tree/v2.8.3), with no external search service or provider credential. The default is QMD BM25 keyword retrieval. Each parent has its own `tasks/<parent-hash>/qmd/index.sqlite` and private Markdown collection under `qmd/views`. The collection contains one primary representation per exact source passage, built from validated native content. Results return current task associations rather than indexing surrounding chronological context again for each task. Text omitted from the compact timeline remains searchable in these bounded, nonoverlapping pages; images and other non-text blocks remain available through exact source references.

Archive commits schedule a coalesced background update in a separate process. Startup and the idle timer reconcile missed updates; every search also reconciles changed and deleted views before querying. Neither message ingestion nor user dispatch awaits indexing or local inference. A filesystem lock serializes view/index updates across the host and MCP processes, then releases before model work. A separate nonblocking inference lock keeps keyword search available while another local model job is running. Candidate paths, live view hashes and source files are checked within the authorized parent's namespace before results are returned. Symlinks into another namespace and stale/deleted views are excluded.

Optional inference accepts **existing absolute local `.gguf` paths** through `POCKET_QMD_EMBED_MODEL` and `POCKET_QMD_RERANK_MODEL`. Pocket does not resolve remote model URIs or download models. An available embedding model enables QMD vector indexing and typed `lex`/`vec` retrieval with reciprocal-rank fusion. An available reranker enables QMD local reranking. Query expansion is deliberately disabled, so no third model is required. Both per-store configuration and QMD's process-global tokenizer environment are pinned to the checked local paths. Missing models, busy inference, runtime failures and worker timeouts fall back to QMD keyword retrieval with a reported reason.

The existing first MCP text block remains a JSON result array. Each result links to its actual matching Markdown page and task timeline, gives exact source ID/sequence/file references, nearby records, literal matched terms, QMD scores/explanation traces and real passage offsets. A second text block and `structuredContent` report retrieval mode and pagination even when there are no matches. Semantic matches need not contain literal query terms; the response never invents an explanation. Empty or punctuation-only queries return no matches. Pass `pagination.nextOffset` to continue. Retrieval uses a bounded candidate window of 100 pages and reports when that window is full; it does not claim an exhaustive total beyond that window.

The focused history workflow verifies native migration, exact source-backed QMD/MCP retrieval, passage offsets, parent isolation, unchanged restart ingestion, and interleaved tasks that remain open. The task-management, lifecycle, and rollout workflows cover real persistence, Pi/MCP provenance, span-preserving repairs, source deduplication, stale classifications, and conservative migration. Synthetic provider responses verify orchestration, not model quality. See the [coverage map](test-suite.md).

## Decisions API boundary

`intent-classifier.ts` uses the documented [Decisions API](https://developers.openai.com/api/docs/guides/decisions), `POST https://api.openai.com/v1/decisions`, with the supported predicate contract and fixed `gpt-6-luna` model. It supplies `current_request`, bounded `relevant_references`, and task descriptions as evidence. It requests `actionable`, `independent`, `cancel`, `correction`, and one `task_<index>` predicate per candidate task. Responses must contain each requested predicate exactly once with a probability between zero and one. The local limit of 100 candidate tasks plus four intent predicates fits the documented limit of 400 questions per request.

The interpretation policy uses 0.8 acceptance and 0.2 rejection thresholds. Ambiguous or conflicting membership stays unresolved; multiple tasks can be repaired through explicit content spans. Provider probability is retained as confidence, not an accuracy claim. HTTP failures, refusals, malformed responses, and stale results do not discard source context or force membership.

No authenticated Decisions quality evaluation was performed. Account/model entitlement, rate limits, and classification quality remain unverified. Unsupported or unavailable provider access leaves interpretation pending with a private diagnostic.

## Shared interfaces

Voice calls `Bridge.handoff({ id, request, source: { type: "realtime", sessionId, itemId, intent, intentContext } })`. The original backend packet is delivered exactly, including whitespace. Current observed speech and bounded current-call references remain separate from saved historical context. The durable outbox retains source metadata, uses the stable ID across restart, and rejects retries with different content/source. Handoff may deliver while voice is active. `Bridge.send(id, text, attachmentIds?)` stays compatible. The complete OpenAI voice replacement belongs to JUA-69; the old native realtime RPC is explicitly unsupported on Pi.

Side Pocket reports retain their original text and ownership in the canonical mailbox and reach the main agent as internal context. They are not rendered as main-Pocket messages. Explicit `pocket_send_to_chat` deliveries use native tool-call identities in canonical Pi history; ordinary worker text remains private to voice. Report receipts can be delivered while voice is active, and the main agent’s later response updates the live conversation without another user request.

## Verification boundaries

Focused application workflows cover active-voice handoff, durable uncertainty and restart deduplication; successful-report association and complete parent-visible content; the real Pi SDK's tool loop, questions and history restoration; and parent-scoped QMD retrieval. The source-ingestion workflow uses synthetic Decisions responses and verifies that unrelated requests cannot resolve earlier work. The [suite map](test-suite.md) records retained native delegation/control flows and local evidence. CI owns complete suites. Physical-device voice and authenticated providers remain unverified for the replacement.
