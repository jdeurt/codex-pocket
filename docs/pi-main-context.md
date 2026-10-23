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

Pi exposes its built-in tools, preserves structured phone questions through a native-cancellable `request_user_input` compatibility tool, and connects the same parent-scoped Pocket MCP server for scheduling, Side Pockets, adoption, spinner and session tools. Project instruction and skill discovery remain native Pi behavior. Executable project extensions are not auto-trusted. The effective existing developer instructions are composed with Pocket's main prompt.

`pocket_session_models` lists Pi catalog selections. Main model settings resolve `provider/model` identities through that catalog; bare IDs select OpenAI. Unsupported names fail explicitly. Settings apply to subsequent turns and persist separately per parent. Native delegates retain the host's native Codex model/effort defaults, with explicit per-child overrides still available. Arbitrary Pi provider/model IDs or thinking levels are not passed into native Codex/Claude configuration. Claude keeps its own model selection and permission checks.

On first migration, complete Codex history is saved as `legacy-codex.md` for silent retrieval and copied into a Pi custom context entry without executing it again, and its original phone transcript IDs are retained. New exact Pi source and the phone projection are private durable files. Interrupted Pi work is marked interrupted on restore; accepted or uncertain submissions are never replayed as fresh user input. Existing Pocket restart recovery remains separate.

## Task grouping and archival

An idle-session timer runs approximately every ten minutes and skips unchanged chat state. New user input preempts provider classification. Grouping reads only the directly maintained active state: the open group and unassigned pending users. It rebuilds the open anchor with the same task ID and Markdown path. It compares each candidate against the full matched user set; a match resets the counter. Five consecutive nonmatches close the group. Time alone does not close it.

Private `tasks/<parent-hash>/active.json` stores the source cursor, revision, last processed revision, open identity and active user messages. Closed membership is removed and is not read by the grouping loop. Checkpoints preserve task identity across API errors and process restarts. Failed/refused classification leaves the pass eligible for retry.

Exact source records are stored independently under `source/<sequence>.json`. Markdown task files contain an ordered source envelope, including interleaved users, calls and results. Task membership is explicit in the file metadata; interleaved context can be duplicated across task files. Archival reads source intervals, not historical task membership. This preserves late tool results after another user steers a run. Literal backticks are JSON-escaped reversibly so source content cannot terminate the archive fence.

After closing groups, Pi's native compactor receives archive references and instructions to retain open work, decisions, constraints, questions and delegate identities. Native auto-compaction also retains the append-only Pi source. `pocket_task_search` searches this parent's Markdown archive only; Pi reads returned files directly to recover exact original context. The main system prompt requires silent retrieval before answering references to prior shared work. Search currently uses keyword ranking; no embedding library or additional provider credential is needed.

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

`DelegateReport.final?: { commandId: string; outcome: "completed" }` identifies one report associated with a persisted successful native command. It selects the last explicit parent report or generated completion fallback. A completed delivery, progress message, interrupted result or later assignment does not prove successful completion. Original report text remains unchanged. Chat UI owns indicator rendering.

## Verification boundaries

Focused business flows cover active-voice handoff and restart deduplication; successful-report association across store reopen; the real Pi SDK's builtin/MCP tool loop and history restoration; and Decisions-schema grouping, open-anchor reuse, counter resets, exact interleaved archival and parent-scoped retrieval. Existing native delegation and parent-control flows remain focused regression checks. CI owns complete suites. Physical-device voice behavior and authenticated provider behavior were not tested here.
