# Task management architecture

`src/tasks/` owns task ingestion, membership, archives, and retrieval. Surrounding server adapters consume its interfaces.

## Boundaries

- Pure values and transformations: `archive-model.ts`, `legacy-model.ts`, `render.ts`, `adapters/legacy-model.ts`, and `retrieval/{model,documents,passage,protocol}.ts`.
- Effectful owners: `runtime.ts` coordinates Pi ingestion and background work; `legacy-runtime.ts` coordinates the existing grouping pass; `classifier.ts` calls the Decisions API; `archive.ts` writes exact sources and projections; `adapters/{legacy,legacy-read}.ts` read or import existing archives; retrieval's remaining modules own files, QMD, locks, and subprocesses.

This first consolidation preserves the existing grouping algorithm and storage formats. It does not establish task completion semantics. The legacy five-nonmatch rule, source duplication in chronological envelopes, and grouping-triggered compaction remain until the provenance and lifecycle rollout replaces them. Effects have explicit module owners; legacy runtime methods still contain decisions to be extracted during that rollout.

The planned ledger records trusted request and command relationships before semantic classification. Its deterministic routing and state transitions are separate from provider interpretation, retention, delivery evidence, and generated Markdown. Historical membership remains a legacy decision, and missing historical provenance remains unknown. Migration must never replay a request or delegate command.

## Provenance ledger and shadow routing

`model.ts` defines the ledger; `provenance.ts`, `routing.ts`, `transitions.ts`, and `reconciliation.ts` make deterministic decisions from explicit inputs. `repository.ts` owns a private per-parent SQLite checkpoint. One immediate transaction commits events, membership, decisions, correlations, and cursor changes together. Classification proposals use an expected revision so concurrent ingestion cannot silently overwrite them.

Acceptance records a stable request ID before semantic assignment. The native Pi adapter writes a metadata-only binding intent before Pi appends a user message; restart reconciliation uses an exact object fingerprint, including the native timestamp. Missing or conflicting bindings remain unresolved. Recovery and saved voice history are operational or historical context. The current voice intent is a separate structured field; speech may still be incomplete.

An awaited Pi tool hook records command-key provenance before managed delegate dispatch. Each command inherits that request, so reusing a child does not reuse its task assignment. Mailbox reports carry the exact producing command where the caller provides it. Reports with missing command origins remain unresolved. No correlation is extracted from a marker in message text.

This stage runs deterministic routing in a shadow ledger and keeps the legacy live archive unchanged. Tests exercise real SQLite storage, the Pi SDK, and native MCP delegation tools with synthetic provider responses. They establish orchestration and persistence behavior, not model classification quality. Native records remain the evidence; navigation text is not evidence of completion or user delivery.

## Lifecycle, semantic interpretation and repair

`intent-classifier.ts` submits the current request and bounded descriptions of original task intent, summaries, and pending questions to the Decisions API. Archived tasks remain eligible. `interpretation.ts` applies explicit acceptance and rejection thresholds; multiple matches or uncertain probabilities remain unresolved. A contextual cancellation follows an established task, and an explicit correction can reopen work. Provider probabilities are retained as uncalibrated confidence, not accuracy guarantees.

`classification-runtime.ts` holds no database lock during network calls and discards a result if new acceptance changes its expected revision. In the staged rollout, the idle pass records proposed assignments and `routing-shadow.json` comparisons without changing the legacy archive. Shadow tasks carry `authority: proposal`; they are not authoritative historical repairs.

`lifecycle.ts` centralizes work state, retention, move, split, merge, and explicit original-text spans. Resolution and cancellation require task-member evidence. Repair decisions supersede prior membership, preserve unrelated spans, and retain original messages and original task intent. `invariants.ts` enforces append-only event, decision, and lifecycle evidence. `pocket_task_inspect` exposes the inspected revision; `pocket_task_change` requires that revision and a concrete explained operation. Historical repairs require the user's authorization of the concrete proposal.

`context.ts` selects pending tasks, questions, unresolved requests, and command identities independently of grouping. Its planner refuses compaction when protected context exceeds the explicit budget. `delivery-evidence.ts` records confirmed canonical chat persistence from `pocket_send_to_chat`; an ordinary completed model turn cannot create that delivery evidence or resolve work.

Focused workflow tests use actual persistence and the Pi/MCP boundary. Canned intent evidence verifies greetings and short cancellations, archived-task references, ambiguity, repairs, and stale-response handling. Authenticated model classification quality remains unmeasured.
