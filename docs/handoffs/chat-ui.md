# Chat UI / transcript handoff

Recovered on 2026-10-23. The active replacement owns original PR27 acceptance work. Do not merge or deploy; the coordinator owns merging. Deferred reports remain paused until all original PRs, including PR27, are merged.

## Branch and source

- Branch: `codex/chat-transcript`; draft PR: https://github.com/jdeurt/codex-pocket/pull/27 (base `main`).
- Recovered checkpoint: `7be2271c1b2b597d16461769cdcc1616aa85902b`; its runtime source was `5fe53c98922cb72163be0f090e1b36b2a87195a7`.
- Current source is the commit containing this recovery update; resolve its exact SHA with `git rev-parse HEAD` and consult PR27 for exact-head CI.
- Base main: `e48e60ad70d10d3d8532027e20d930c40fb75763`, incorporating all five sibling PRs: Prompts #22, Settings #23, Browsing #24, Voice #25, Harness #26.
- Read `AGENTS.md`, applicable repository/skill instructions, and full Linear descriptions/acceptance criteria before editing. Original tickets: JUA-49, JUA-51, JUA-52, JUA-59, JUA-60, JUA-61, JUA-63, JUA-66. Never touch peer messaging JUA-65.
- Run extremely focused tests only; never a local full suite. No new unit tests. Lint edited batches. CI owns full-suite validation. Do not configure real credentials, persistent access, security settings, or Pocket model preferences for the Cloud-session migration.

## Completed original scope

- Consistent activity/message spacing; measured status row and composer geometry; wider centered desktop transcript with symmetric scrollbar gutters.
- Shared existing disclosure motion; click expanded report/activity/tool bodies to collapse while preserving controls, links, selections and image dialogs; left-aligned Open Side Pocket action.
- Incoming report indicator/disclosure requires durable final-report provenance; interim/legacy reports remain readable without it.
- Shared readable tool names, command word-boundary previews, per-file native operation labels, accessible failure icons, and main-Pocket visibility through central Settings. Ordinary messages and tool images remain visible when details are hidden. Pi command/edit labels survive results and saved-history reload.
- Scoped native retry notices clear on resumed assistant output, completion, or successful rehydration while fatal errors remain separate.
- Stable footer identity and late initial tail anchoring. Initial following permanently disables after reader control (`initialEnd.current &&= ...`), including returning to the bottom before covered navigation. Parent offsets/visible anchors survive incoming updates while covered.
- Latest main integration preserves Voice's typed `VoiceSegment` and identity-based handoff reconciliation, provider fixtures/microphone probe, and Browsing's loading/footer behavior. Conflicts were resolved in favor of these sibling interfaces. Suspended-audio capture uses an explicit method definition plus a live-stream acquisition wait; cleanup assertions remain intact.

## Contracts and remaining dependency

- Settings owns `GET/POST /api/settings` and `usePocketSettings().data?.showToolCalls ?? false`; do not introduce another preference store.
- Harness owns `DelegateReport.final?: { commandId: string; outcome: "completed" }`, selected from durable successful command results, never delivery status.
- Chat adds display-only `Item.toolLabels` and scoped `Snapshot.connectionRetry`. Preserve `toolLabels` in agent projection and Pi completed-result/history projection.
- Browsing owns `AgentTranscript.isHistoryLoading`, `useAgentRead` loading, list ordering and `Conversation.footer?: ReactNode`.
- Pi uses host process permissions. Codex sandbox parity is not required; do not claim Codex restrictions are enforced by Pi.
- Claude now captures successful, applied native `Write` results before the SDK discards their structured metadata. Existing private child metadata retains only operation/path plus native session, subagent and call identity. Both saved-history readers restore `Item.toolLabels`; the transcript cache invalidates when this provenance changes. Staged, failed, ambiguous and legacy results without evidence retain generic labels. Native write execution and permissions are unchanged.
- **Remaining JUA-63 dependency:** native Pi writes still lack verified create-versus-replace metadata. Actual creation and replacement through installed Pi 1.4.0 return identical results with `details: undefined`. These rows retain a generic label. Capturing an actual operation would require native write provenance; neither input text nor later filesystem state proves it. No inferred operation or replacement write implementation was added. Native Codex mixed create/edit/delete labels work.

## CI and known failures

- Prior implementation `5fe53c98922cb72163be0f090e1b36b2a87195a7`: [CI39904623588](https://github.com/jdeurt/codex-pocket/actions/runs/39904623588) passed.
- Recovered checkpoint `7be2271c1b2b597d16461769cdcc1616aa85902b`: [CI39906366237](https://github.com/jdeurt/codex-pocket/actions/runs/39906366237) had static/integration, realtime and menubar passed; browser tests were still running during recovery. The new implementation push requires its own exact-head CI. Check PR27 for the current run and continue to conclusion.
- Earlier source `b5604e7e5b6a0016664212176cad2d58cd92db2a`, run https://github.com/jdeurt/codex-pocket/actions/runs/39901514505 : all realtime and 167 browser cases passed; one covered-parent anchor case failed by 424px. Fixed by permanently disabling the initial-end flag after reader control. Exact native navigation/append flow subsequently passed twice and again after Voice integration.
- Earlier history-reader composer-resize failures (four browser profiles) and the WebKit-desktop 74px reload/notification-tail gap were fixed and their exact focused cases passed. No assertions were weakened.
- Some superseded runners stalled in Ubuntu browser-dependency downloads and were cancelled after newer source heads replaced them. Distinguish installation failures from source failures. Do not keep retrying artifact downloads: earlier connector/CLI artifact downloads returned HTTP 403; job logs and local traces were sufficient.

## Focused verification and reproduction

Recovery validation uses one focused integration flow through the production Claude adapter, the unmodified SDK with an isolated protocol simulator, the real delegation database, actual SDK saved-history reader and transcript cache. It covers create/update labels, staged/failed/unknown/unrelated-tool results, legacy history, and metadata arriving after a cached read. The simulator now accepts the installed SDK's `--name=value` flags. The two existing Claude SDK conformance flows also pass. No real credentials or native model calls are used.

```sh
node --import tsx scripts/test-flows.ts tests/claude-write-flow.test.ts --test-name-pattern='Claude write provenance'
node --import tsx scripts/test-flows.ts tests/simulator-flow.test.ts --test-name-pattern='unmodified Claude SDK|Claude SDK permission callbacks'
```

Before recovery, final-main integration passed edited-file ESLint/Prettier and TypeScript. These exact business flows passed (select only what a new change/failure warrants):

```sh
CODEX_THREAD_ID= npx playwright test tests/browser/agent-browser.spec.ts --project agents --grep 'parent offsets survive incoming appends'
CODEX_THREAD_ID= npx playwright test tests/browser/virtualization-tools.spec.ts --project virtualization-chromium-phone --grep 'host tool preference'
CODEX_THREAD_ID= npx playwright test --config playwright.realtime.config.ts tests/browser/realtime.spec.ts tests/browser/realtime-handoff.spec.ts --project realtime-webkit-phone --grep 'stop while audio context is suspended|configured OpenAI voice hands off exact speech'
```

Earlier focused checks also passed: held native history refresh, native retry/reconnect, durable handoff/final-report provenance, actual Pi SDK faux-provider tools/history, saved tool rendering, report/activity disclosure interactions, four history-reader composer-resize profiles, WebKit tail geometry, desktop centering and fractional real-upload widths. Useful exact selectors:

```sh
node --import tsx scripts/test-flows.ts tests/pi-main-flow.test.ts --test-name-pattern='Pi main executes native tools'
node --import tsx scripts/test-flows.ts tests/transcript-recovery-flow.test.ts --test-name-pattern='native retry notice clears'
CODEX_THREAD_ID= npx playwright test tests/browser/virtualization-tail.spec.ts --project virtualization-webkit-desktop --grep 'agent presence retains activity-line geometry'
CODEX_THREAD_ID= npx playwright test tests/browser/focused-scroll.spec.ts --project focused-webkit-desktop --grep 'composer focus and visual viewport changes preserve a history reader'
```

Prior Cloud setup: dependencies installed with `XDG_CACHE_HOME=/tmp/pocket-cache npm ci --cache /tmp/pocket-npm-cache --no-audit --no-fund`. Playwright Chromium download returned 403; local checks used `/usr/bin/chromium`. Ignored `.local` wrapper configs import the normal config, set `testDir: "../tests"`, filter `webServer` to `agent-replay` or `browser-local`, filter the chosen project, and use Chromium `launchOptions.executablePath: "/usr/bin/chromium"`. Recreate wrappers in a fresh workspace rather than assuming they were committed. Realtime wrapper imports `playwright.realtime.config.ts`, sets `testDir: "../tests/browser"`, and selects `realtime-webkit-phone`.

In the prior Cloud workspace, WebKit v2370 was under `/tmp/pocket-browsers`; missing libraries were extracted under `/tmp/pocket-webkit-libs` and linked into that browser's `sys/lib`. Local WebKit commands additionally used `PLAYWRIGHT_BROWSERS_PATH=/tmp/pocket-browsers PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`: the latter skips only a dependency detector whose ldconfig catalog could not see staged libraries. No OS/security settings changed. These temporary dependencies and logs are not available automatically in a new workspace. Prefer ordinary Playwright installation when available.

## Shared backport and deferred work

- Optional one-file backport: branch `codex/shared-transcript-anchoring`, commit `6319e5bdfe25355a70ee94951f04c09a67d28622`, based on main `bcf337a`. It supersedes **71f4822 (do not use)**. Corrected isolated-main parent-navigation flow passes; earlier isolated tail and four history-reader checks passed. Both sibling PRs received this handoff; Browsing and Voice subsequently merged normally. The full Chat branch already contains the correction.
- User explicitly deferred new reports until **all original six PRs have merged**, including PR27: duplicate Pi user bubbles; Pi thinking/tool lifecycle status; model-switch/tool-call semantics; missing delegate activity; delegate bottom spacing; Side Pocket messages rendered as user messages; restart notices rendered as user messages. Do not resume them before the coordinator confirms that sequencing condition. Then perform one integrated current-main retest, coordinating with Harness rather than racing another fix or deduplicating legitimate identical sends by text.
- Incomplete Pi-status investigation is preserved as `chat-ui-pi-status-deferred.patch` beside this file. It was exported from local stash `efe1ac39247d5d5fad3193148367e82bf70de738` with zero-context hunks. It is **reference material, not applied runtime code**. Do not apply it blindly; its helper has lint failures and no lifecycle/UI verification. It proposed a separate activity helper after existing Pi message projection, leaving user identity untouched. Notes: current Pi message handler ignores native `tool_execution_*`; generic tool traces fall back to consideration. A possible `turn/interrupt` forwarding issue was reported to Harness but not fixed/validated here. All of this remains deferred.
- Harness duplicate-audit thread: `01a16695-03fa-73a4-a4a1-ddb5aa1260d0` (paused). Coordinator thread: `01a16696-74f5-700f-b5d5-dbf1c7ed10e2`. Direct Cloud-thread messaging was unavailable in this context; GitHub comments and coordinator relay were used.

## Next actions

1. Check out the latest `codex/chat-transcript` head and read PR27 for exact-head CI and remaining acceptance gaps. Recovery adds durable Claude write provenance to the prior implementation; the deferred patch remains unapplied.
2. Finish CI on the exact pushed head; inspect concrete failures, fix only original-scope regressions, lint incrementally, and run only their focused reproductions. Report infrastructure failures distinctly. Do not stop merely at a pending run unless the parent explicitly hands ownership off again.
3. Report green head and the remaining Pi/legacy JUA-63 metadata gap to the coordinator. The coordinator alone merges PR27. Do not deploy.
4. Only after all original PRs merge, follow the coordinator's integrated-retest plan for the deferred reports. Parent requested a new Astra High Cloud session; fast service tier was not exposed in this context, so do not claim it was enabled or change Pocket's application model settings.
