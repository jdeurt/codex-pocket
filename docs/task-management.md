# Task management architecture

`src/tasks/` owns task ingestion, membership, archives, and retrieval. Surrounding server adapters consume its interfaces.

## Boundaries

- Pure values and transformations: `archive-model.ts`, `legacy-model.ts`, `render.ts`, `adapters/legacy-model.ts`, and `retrieval/{model,documents,passage,protocol}.ts`.
- Effectful owners: `runtime.ts` coordinates Pi ingestion and background work; `legacy-runtime.ts` coordinates the existing grouping pass; `classifier.ts` calls the Decisions API; `archive.ts` writes exact sources and projections; `adapters/{legacy,legacy-read}.ts` read or import existing archives; retrieval's remaining modules own files, QMD, locks, and subprocesses.

This first consolidation preserves the existing grouping algorithm and storage formats. It does not establish task completion semantics. The legacy five-nonmatch rule, source duplication in chronological envelopes, and grouping-triggered compaction remain until the provenance and lifecycle rollout replaces them. Effects have explicit module owners; legacy runtime methods still contain decisions to be extracted during that rollout.

The planned ledger records trusted request and command relationships before semantic classification. Its deterministic routing and state transitions are separate from provider interpretation, retention, delivery evidence, and generated Markdown. Historical membership remains a legacy decision, and missing historical provenance remains unknown. Migration must never replay a request or delegate command.
