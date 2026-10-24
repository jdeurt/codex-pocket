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

## Task grouping and archival

An idle-session timer runs approximately every ten minutes and skips unchanged chat state. New user input preempts provider classification. Grouping reads only the directly maintained active state: the open group and unassigned pending users. It rebuilds the open anchor with the same task ID and Markdown path. It compares each candidate against the full matched user set; a match resets the counter. Five consecutive nonmatches close the group. Time alone does not close it.

Private `tasks/<parent-hash>/active.json` stores the source cursor, revision, last processed revision, open identity and active user messages. Closed membership is removed and is not read by the grouping loop. Checkpoints preserve task identity across API errors and process restarts. Failed/refused classification leaves the pass eligible for retry.

Exact source records remain independently stored under `source/<sequence>.json`. Each task has a readable Markdown timeline and a separate exact JSON envelope with its membership metadata. The view preserves native IDs, recorded timestamps, chronological order and call IDs. Late results reference the originating call without moving them ahead of intervening messages. Unknown or ambiguous call ownership is stated explicitly. Each record preview is bounded; non-text content stays in the original record, and truncated text includes an omission count. Interleaved context can occur in multiple tasks, but membership remains explicit. The view records its envelope hash so readers can reject mismatched versions during an update. Old fenced-JSON archives remain readable without rewriting their retained history.

After closing groups, Pi's native compactor receives archive references and instructions to retain open work, decisions, constraints, questions and delegate identities. Native auto-compaction also retains the append-only Pi source. Imported Codex history uses the same reading view with its complete native envelope retained separately. These views do not replace or shorten the exact source history.

### Local earlier-task search

`pocket_task_search` now uses the pinned [`@tobilu/qmd` 2.8.3 SDK](https://github.com/tobi/qmd/tree/v2.8.3), with no external search service or provider credential. The default is QMD BM25 keyword retrieval. Each parent has its own `tasks/<parent-hash>/qmd/index.sqlite` and private Markdown collection under `qmd/views`. The collection contains readable detail pages built with the same native-content projection as the timeline. Text omitted from the compact timeline remains searchable in these bounded, overlapping pages; images and other non-text blocks remain available through exact source references.

Archive commits schedule a coalesced background update in a separate process. Startup and the idle timer reconcile missed updates; every search also reconciles changed and deleted views before querying. Neither message ingestion nor user dispatch awaits indexing or local inference. A filesystem lock serializes view/index updates across the host and MCP processes, then releases before model work. A separate nonblocking inference lock keeps keyword search available while another local model job is running. Candidate paths, live view hashes and source files are checked within the authorized parent's namespace before results are returned. Symlinks into another namespace and stale/deleted views are excluded.

Optional inference accepts **existing absolute local `.gguf` paths** through `POCKET_QMD_EMBED_MODEL` and `POCKET_QMD_RERANK_MODEL`. Pocket does not resolve remote model URIs or download models. An available embedding model enables QMD vector indexing and typed `lex`/`vec` retrieval with reciprocal-rank fusion. An available reranker enables QMD local reranking. Query expansion is deliberately disabled, so no third model is required. Both per-store configuration and QMD's process-global tokenizer environment are pinned to the checked local paths. Missing models, busy inference, runtime failures and worker timeouts fall back to QMD keyword retrieval with a reported reason.

The existing first MCP text block remains a JSON result array. Each result links to its actual matching Markdown page and task timeline, gives exact source ID/sequence/file references, nearby records, literal matched terms, QMD scores/explanation traces and real passage offsets. A second text block and `structuredContent` report retrieval mode and pagination even when there are no matches. Semantic matches need not contain literal query terms; the response never invents an explanation. Empty or punctuation-only queries return no matches. Pass `pagination.nextOffset` to continue. Retrieval uses a bounded candidate window of 100 pages and reports when that window is full; it does not claim an exhaustive total beyond that window.

The current `tests/workflows/history.test.ts` verifies native history migration, source-backed QMD/MCP retrieval, exact passage offsets and parent isolation. Its live Pi ingestion scenario verifies seven completed turns before shutdown, resumes without duplicate source ingestion, executes grouping against all documented Decisions exchanges and retrieves the archived original content. Pocket queues source-tail reads after native message persistence; the workflow waits on explicit live-ingestion readiness before shutdown. The Pi workflows cover tools, questions, ordered steering, retry, interruption and model selection. Vector/reranker implementation probes, broad pagination/reconciliation matrices and held-index-lock orchestration were retired; live GGUF inference remains unverified. See the [coverage map](test-suite.md) for exact boundaries.

## Verified Decisions API contract

The official [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions) documents `POST https://api.openai.com/v1/decisions`. The implementation uses its supported predicate question and fixed supported model:

```json
{
  "model": "gpt-6-luna",
  "input": "{\"matched_user_messages\":[\"...\"],\"candidate_user_message\":\"...\"}",
  "questions": [
    {
      "type": "predicate",
      "name": "same_task",
      "instructions": "Determine whether the candidate continues the task represented by the full matched set."
    }
  ]
}
```

It sends the key in the Authorization Bearer header. The successful response must contain exactly one matching predicate:

```json
{ "answers": [{ "type": "predicate", "name": "same_task", "probability": 0.92 }] }
```

Pocket treats probability >= 0.5 as a match. This is an application threshold, not an accuracy guarantee; labeled task examples should calibrate it. Refusals, unexpected answers, HTTP errors and timeouts retain active context and do not advance the successful-pass revision. No undocumented Responses fallback is used.

Documentation verification establishes the endpoint and schema. **No authenticated Decisions or main-model API request was made.** Account/model entitlement, rate limits and classification quality remain unverified. A configured account without endpoint access will leave grouping pending and record a private diagnostic; it will not discard context.

## Shared interfaces

Voice calls `Bridge.handoff({ id, transcript, source: { type: "realtime", sessionId, itemId } })`. The transcript is delivered exactly, including whitespace. The durable outbox retains source metadata, uses the stable ID across restart, and rejects retries with different content/source. Handoff may deliver while voice is active. `Bridge.send(id, text, attachmentIds?)` stays compatible. The complete OpenAI voice replacement belongs to JUA-69; the old native realtime RPC is explicitly unsupported on Pi.

Side Pocket reports retain their original text and ownership in the canonical mailbox and reach the main agent as internal context. They are not rendered as main-Pocket messages. Explicit `pocket_send_to_chat` deliveries use native tool-call identities in canonical Pi history; ordinary worker text remains private to voice. Report receipts can be delivered while voice is active, and the main agent’s later response updates the live conversation without another user request.

## Verification boundaries

Focused application workflows cover active-voice handoff, durable uncertainty and restart deduplication; successful-report association and complete parent-visible content; the real Pi SDK's tool loop, questions and history restoration; and parent-scoped QMD retrieval. The Decisions-backed grouping scenario passes with the live-ingestion correction described above. The [suite map](test-suite.md) records retained native delegation/control flows and local evidence. CI owns complete suites. Physical-device voice and authenticated providers remain unverified for the replacement.
