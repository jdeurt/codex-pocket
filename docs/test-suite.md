# Business-flow test suite

The suite keeps integration and end-to-end business flows. A test needs to exercise a useful operation across real application boundaries: native RPC/MCP transport, durable storage, an installed command, an HTTP route, or a user interaction. A helper returning the expected object is a unit test even when its filename says “flow.”

The cleanup was explicitly requested after the DX fixes. Commit `749f18c` passed the complete [CI workflow](https://github.com/jdeurt/codex-pocket/actions/runs/39853635789) before coverage was removed. These removals do not substitute for fixing failing business flows.

## Audit result

| Inventory                        | Before cleanup | After cleanup |
| -------------------------------- | -------------- | ------------- |
| Test files                       | 81             | 64            |
| Test declarations                | 217            | 149           |
| Lines in test files              | 12,970         | 9,924         |
| Default offline Playwright cases | 201            | 165           |
| Realtime Playwright cases        | 75             | 57            |

Declarations count authored `test(...)` calls; loops can produce multiple cases, and Playwright projects expand cases across environments. Browser totals include platform-specific cases: the earlier green default run had 196 passes and five skips. Current totals come from discovery with `--list`, which does not run tests.

## Removed

Twelve isolated unit-test files were removed:

- `activity.test.ts`, `core.test.ts`, `deliveries.test.ts`, `recovery.test.ts`, and `turn-messages.test.ts`: in-memory reducers, projections, validation, and formatting.
- `agent-read-pool.test.ts`, `effort.test.ts`, and `harness.test.ts`: isolated scheduling helpers, mocked RPC requests, and configuration mapping.
- `images.test.ts`, `logging.test.ts`, and `snapshot-stream.test.ts`: individual renderer, logging, and parser utilities. Image delivery and streaming remain covered through application flows.
- `simulator-state-flow.test.ts`: direct tests of simulator classes. Production Codex transport and the unmodified Claude SDK still run against those simulators.

Unit cases inside `delegations`, `setup`, `push`, `schedules`, `notification-presence`, `install-release`, and `pocket-cli` were removed while their native transport, storage, installation, and delivery flows remain. The owner-unavailable adoption case was also removed because it only checked rejected discovery and absent work; successful adoption, corrections, detach, and reconnect flows remain.

Five browser files were removed: `realtime-spectrum.spec.ts`, `virtualization-pwa.spec.ts`, `virtualization-spacing.spec.ts`, `virtualization-spinner.spec.ts`, and `virtualization-silent.spec.ts`. These were component-pixel/CSS emulation probes or absence/empty-extent checks. The empty-marker wrapper measurement, copy-action exclusion matrix, historical restart-notice exclusion, and status-only geometry loop were removed from mixed files. Copying, streamed marker completion, actual restart recovery, agent navigation, and voice activation remain covered.

Negative assertions inside meaningful flows remain. Installation rollback, access control, cancellation, duplicate delivery, and draft preservation test operations and state transitions; an assertion that a stale item disappeared is not itself a reason to remove those flows.

## Simplified

- Ordinary transcript, disclosure, projection, pending-answer, and bookmark fixtures use 320 rows rather than 700–1,200. This remains above the 250-row mounted bound. Dedicated large-history and nested-activity stress cases still use 1,200 items.
- The smaller bookmark fixture exposed an image-decoding restoration defect. The flow retains its images and three-pixel anchor tolerance; cached restoration now compensates rows before the saved anchor rather than treating the temporarily shortened anchor row as preceding the reader.
- Spinner persistence is a direct select/deduplicate/restart/reset/delete flow, replacing a test-only class with many single-operation methods. It still checks original bytes, animation frames, private storage, restart persistence, and ownership of deleted files.
- Spinner permission coverage uses two real MCP clients instead of five. A main selection survives a child mutation attempt, and the main client can still reset it.
- Spinner input recovery uses corrupt local input and a remote source, then successfully selects the original asset again. It avoids constructing a large rejection matrix of equivalent invalid inputs.
- Spinner browser coverage runs the complete rendering/restart/missing-asset flow once per engine, using Chromium desktop and WebKit phone, rather than repeating the entire flow at both viewport sizes for each engine.
- The schedule storage flow directly exercises CRUD, stale revisions, database reopen, occurrence claiming/recovery, and retained history. MCP discovery checks the schedule tools used by that flow instead of snapshotting unrelated tool catalogs and schemas.
- Installer preparation covers the two distinct failure paths: a thrown build and missing output. The removed dependency/setup/check variants all invoked the same throwing callback. Successful activation, rollback, lock recovery, and failed first launch remain.
- Prompt preservation starts one new process and one reconnect process, rather than repeating the same resume path under two stage names.
- HTTP upload and realtime media-lane cases run once in dedicated API projects. They do not depend on browser viewport settings. Recovery runs on Chromium phone and WebKit phone; desktop continues to exercise realtime UI and gesture flows.

The cleanup introduces no broad application mocks or blanket retries. Existing external protocol simulators and the outbound push boundary remain explicit; business state, storage, routes, and production adapters execute normally.

## Running checks

`npm test` runs all retained offline integration flows in CI. `npm run test:simulators` selects production adapter/SDK integration flows. Both use `scripts/test-flows.ts`, which isolates the home directory and credentials and rejects unknown file selections.

For agent development, select one file and case:

```sh
node --import tsx scripts/test-flows.ts tests/schedules.test.ts --test-name-pattern='schedule CRUD retains revisions'
npx playwright test tests/browser/virtualization-pocket-scroll.spec.ts --project=virtualization-chromium-desktop --grep 'a Pocket restores its native virtualizer bookmark'
```

Run ESLint on each editing batch and leave full-suite execution to CI, as required by [AGENTS.md](../AGENTS.md). CI for the cleanup revision must be evaluated separately from the earlier green DX revision.
