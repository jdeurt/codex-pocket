# Pocket work handoff — October 20, 2026

> Historical record from October 20, 2026. Status, instructions, and verification below describe that point in time and may be superseded. Use the [current documentation](../README.md) for setup and supported behavior.

All implementation, delegated work, tests and deployments are **stopped at Juan's request**. The only authorized activity after the stop was saving existing work, publishing branches and preparing this handoff. Nothing should resume automatically.

Repository: [jdeurt/codex-pocket](https://github.com/jdeurt/codex-pocket).

## Consolidated state

| State                                            | Revision / branch                                                                                                  | Meaning                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Last recorded successful deployment              | `86b9babfd2c3064b0a17c9b91ea50d4ab429af98`                                                                         | Production build `9XOweNPtQ2SoonfUeot8c`; deployment record is dated October 20, 2026, 08:32 UTC. No newer deployment was performed. |
| Latest local consolidated implementation         | `38c5ac696df3dbbab0b295fa1009e2d7a531e2a5`                                                                         | Includes the composer-focus fix; that fix has not been deployed.                                                                     |
| Published consolidated snapshot and this handoff | [handoff/stopped-pocket-2026-10-20](https://github.com/jdeurt/codex-pocket/tree/handoff/stopped-pocket-2026-10-20) | Based on local `main` at `38c5ac6`, with handoff documentation added. It preserves the completed local cleanup and integrations.     |
| Remote `main` at publication                     | `d47e288873c49271ce3bd0343d3311d90da8f31c`                                                                         | The consolidated implementation was 103 commits ahead. This handoff does not merge into or update remote `main`.                     |

Local project root: `/Users/juan/Documents/ChatGPT/DX/codex-pocket`.

All worktrees below are siblings under `/Users/juan/Documents/ChatGPT/DX/`. Their branches are in the same Git repository. The handoff worktree is `pocket-stopped-handoff`.

Five worktrees contained uncommitted source changes. Those exact files were saved as **WIP commits**, without completing implementation, formatting, tests or acceptance. A pushed branch is a saved snapshot, not a claim that its feature works or is ready to merge.

## Current and deferred tasks

Every branch in this table is published. A branch marked **planning only** contains its starting baseline and no task implementation.

| Task                                                             | Development branch                                                                                 | Saved revision                             | Progress at stop                                                                                                                | Worktree                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Default steering, cancellation and approved prompts              | [feat/delegate-steering](https://github.com/jdeurt/codex-pocket/tree/feat/delegate-steering)       | `a8b947759d1090d5dbd7ba211a2a5e00b1b81d04` | Substantial WIP implementation; final verification and integration unfinished.                                                  | `pocket-delegate-steering`    |
| Agent list flashing / reconnect failure                          | [fix/agent-reconnect](https://github.com/jdeurt/codex-pocket/tree/fix/agent-reconnect)             | `ff6166b6f7e51740e667262159eea6fe97301351` | Live latency observed and blocking cache behavior identified; regression fixture/test WIP only. **No product fix implemented.** | `pocket-agent-reconnect`      |
| Stable agent/status spacing and reaching the full transcript end | [fix/transcript-tail](https://github.com/jdeurt/codex-pocket/tree/fix/transcript-tail)             | `273cbd89a1a0b3a240be24065ed1433d651146cc` | CSS/status-label fix and whole-flow tests saved; latest combined verification unfinished.                                       | `pocket-transcript-tail`      |
| Keep bottom anchored when focusing the composer                  | [fix/composer-focus-end](https://github.com/jdeurt/codex-pocket/tree/fix/composer-focus-end)       | `9af9126441c405b1d1f3e9d25c63912980dbd03c` | Implemented and targeted checks passed. Integrated locally as `38c5ac6`; **not deployed**.                                      | `pocket-composer-focus-end`   |
| Slightly smaller custom spinner                                  | [fix/custom-spinner-size](https://github.com/jdeurt/codex-pocket/tree/fix/custom-spinner-size)     | `bb55ba9711988da45bb2f26bcdcda26eb1c7feb2` | Committed 28px custom image inside the existing 32px slot; final WebKit verification unfinished.                                | `pocket-custom-spinner-size`  |
| Clickable delegate report paraphrases                            | [feat/delegate-summaries](https://github.com/jdeurt/codex-pocket/tree/feat/delegate-summaries)     | `27151b1b17a26d8538897bd155a7d6767c08471f` | Partial UI, protocol and persistence WIP; native summarizer integration and verification incomplete.                            | `pocket-delegate-summaries`   |
| Suppress silent-turn notifications                               | [feat/silent-notifications](https://github.com/jdeurt/codex-pocket/tree/feat/silent-notifications) | `0c97dfee9eb989a86ca8083505248c9e78d8852a` | Partial notification eligibility/shared projection WIP; tests and compatibility checks unfinished.                              | `pocket-silent-notifications` |
| Own-session model, effort and context controls                   | [feat/app-server-controls](https://github.com/jdeurt/codex-pocket/tree/feat/app-server-controls)   | `86b9babfd2c3064b0a17c9b91ea50d4ab429af98` | Planning/protocol inspection only.                                                                                              | `pocket-app-server-controls`  |
| Phone-readable local file viewer                                 | [feat/phone-file-viewer](https://github.com/jdeurt/codex-pocket/tree/feat/phone-file-viewer)       | `86b9babfd2c3064b0a17c9b91ea50d4ab429af98` | Planning only; no viewer code saved.                                                                                            | `pocket-phone-file-viewer`    |
| Lower composer in installed iOS PWA                              | [feat/pwa-composer-inset](https://github.com/jdeurt/codex-pocket/tree/feat/pwa-composer-inset)     | `38c5ac696df3dbbab0b295fa1009e2d7a531e2a5` | Layout investigation only; no PWA adjustment implemented.                                                                       | `pocket-pwa-composer-inset`   |
| Fade only newly arriving content                                 | [feat/new-content-fade](https://github.com/jdeurt/codex-pocket/tree/feat/new-content-fade)         | `38c5ac696df3dbbab0b295fa1009e2d7a531e2a5` | Design/source inspection only; no fade implementation saved.                                                                    | `pocket-new-content-fade`     |
| Usage, tokens and cost analysis                                  | [feat/usage-budget](https://github.com/jdeurt/codex-pocket/tree/feat/usage-budget)                 | `38c5ac696df3dbbab0b295fa1009e2d7a531e2a5` | Collector/CLI design only; no collector code saved.                                                                             | `pocket-usage-budget`         |

## What remains for each task

### Default steering and prompt reorganization

Saved code adds active-turn steering, delivery state in the existing command ledger, selected unsent-task cancellation, completion-race handling, fake native flows and dedicated prompt resources.

- Corrections, answers and changed requirements for the current task should steer its active native turn. Explicit distinct later tasks alone should queue. Steering must not claim another execution slot.
- Codex 0.163.0 supports `turn/steer` with `expectedTurnId`. An acknowledgement confirms acceptance, not that the model has consumed the text.
- The installed Claude SDK has no equivalent conditional active-turn acknowledgement. The agreed direction is explicit **unsupported active steering**, with no silent queued fallback. Idle saved-session delivery remains separate.
- Attempted sends with uncertain outcomes must never be replayed automatically. Preserve identity, permission settings and the durable audit.
- Main Pocket gets the steering/queue policy. **The Side Pocket prompt must contain no steering-versus-queue guidance.** Preserve native Codex instructions and the Claude system preset.
- Worker-reported earlier evidence: 300-file lint at zero errors/warnings/suppressions, root/worker typecheck and format passing; seven new and nine existing targeted fake flows passed in separate runs. A later cancellation edge fix was still being finalized when interrupted. These results do not establish acceptance of the final WIP snapshot.
- Remaining: inspect the saved cancellation/migration evidence, finish final relevant checks, resolve integration conflicts and review before any deployment. Approved text is preserved in [POCKET_PROMPT_DRAFTS.md](POCKET_PROMPT_DRAFTS.md).

### Agent list flashing and failed reconnection

Live evidence showed `/api/events` connected while `/api/agents` was slow. Native `thread/list` acknowledgements took approximately 42.6s, 15.9s and 9.2s; the browser agent request timeout is 10s.

`AgentBrowser.discovery()` currently waits for stale discovery refreshes. Repeated slow refreshes can starve otherwise usable cached agent data. The intended fix is a coalesced background refresh that preserves the last verified catalog and truthful ancestry/status.

The saved branch adds a controllable held-discovery fake RPC stage and an integration regression. Its before-fix run was explicitly stopped; it has no completed result. Product code is unchanged. Implement the cache/reconnect fix, prove retained UI plus eventual recovery, and retain access/scoping checks. Do not solve this by increasing request timeouts or hiding failures.

### Agent/status spacing and full-bottom positioning

Saved WIP makes notification-banner layout independent of agent presence, retains a 44px agent press target without adding row height, and truncates long status text to one line.

- Initial measured agent-presence/banner change shifted the composer by 74px.
- A long status label measured 120px tall and shrank to 32px when its text disappeared; the Kirby regression demonstrated that failure before the label fix.
- Earlier presence/collapse/bottom checks passed 4/4 across Chromium and WebKit phone emulation before the final status-label change.
- The expanded final run did not complete: one attempt failed fixture startup under machine contention, and later work was interrupted/stopped. Verify the final saved source; do not claim all expanded cases passed.
- Keep normal library scrolling and actual disclosure CSS motion. Do not restore canceled custom scroll controllers, staged seeks or held canvas extents.

### Composer focus bottom anchoring

The source fix wraps TanStack's supported viewport-rect observer, preserving the previous end position through viewport shrink only when this list owns end-follow. It uses native `scrollToEnd`; nested activity and suspended/history reading opt out.

Baseline Chromium/WebKit evidence: simulated keyboard shrink left a 520px end gap and exposed the down arrow. All 12 new real-chat cases passed across desktop/phone emulation. Existing focus/touch flows passed; one final WebKit context-teardown timeout occurred after its assertions, and the exact case passed on rerun. Changed-file lint, format, types and diff checks passed. Physical iOS keyboard behavior is unverified.

The fix is already in local consolidated `38c5ac6`. Preserve it when reconciling older branches; deployment remains pending.

### Smaller custom spinner

Only the custom image changes from 32px to 28px. Its slot remains 32px and the default SVG remains 16px, avoiding a layout-height change.

Chromium's existing GIF whole flow passed twice; static checks passed. WebKit rendering was inspected, but an initial scaled-edge pixel sample failed. The sample was moved inward with the same tolerance, and the final WebKit flow was interrupted before completion. The branch is committed on top of local `38c5ac6`; finish only the missing verification if work is later authorized.

The original Kirby GIF is already selected in live private spinner state. Preserve that preference; no replacement or reset is pending.

### Clickable delegate summaries

The WIP includes a fixed paraphrase prompt, stable report/content cache, SQLite display state, protocol/snapshot changes, muted icon/text UI and shared read-only agent navigation. The one-shot native model invocation is incomplete.

- Show only a small message-bubble icon and streamed, heavily paraphrased text at the normal assistant text size. No extra name, label, badge, timestamp or expansion control.
- Clicking the summary opens the sending agent's existing read-only chat. Preserve parent draft/scroll; opening must not send or resume work.
- Preserve full original parent delivery unchanged. Summarization is asynchronous display projection; cache by stable ID/content and provide a readable failure fallback.
- A passing test report is progress, not automatic task completion. Preserve actual questions, choices, blockers and uncertainty.
- Treat report text as untrusted data. The native zero-tools contract remains unresolved: the installed app-server schema has no tool allowlist, while read-only isolation does not remove every built-in tool. The worker asked for clarification; no live summarizer inference was run.
- Remaining: settle the native invocation/tool contract, complete invocation/streaming wiring, reconcile DB/projection overlap and verify whole flows. Current WIP is not validated for merge.

### Silent-turn notifications

Saved WIP reuses visible-turn projection and canonical renderability to select eligible final assistant content or image output, and returns before claiming a push receipt when there is no visible response.

The intended behavior is no completion notification for blank/parser-hidden finals, hidden bookkeeping, delegate-only events or commentary-only activity. Preserve real visible replies/non-text output, actionable questions/approval paths, foreground suppression and replay deduplication.

Tests and caller compatibility are unfinished. In particular, inspect changed completion-payload exports and existing push-flow callers before claiming the branch typechecks. No live notification was sent.

### App-server controls — pending implementation

Expose a small typed surface on the existing authenticated connection: inspect/change this chat's model and effort, return effective settings and persistence timing, and inspect context/token/compaction information with unknown values represented honestly. Reuse the usage contract rather than maintain a second counter.

Prepare a capability matrix for optional model lists, rate-limit/account status, thread/turn state, compaction, queue inspection/cancellation/reordering and background terminals. These candidates are not blanket authorization for arbitrary RPC access. Coordinate connection/queue ownership with the steering task. No implementation exists on this branch yet.

### Phone file viewer — pending implementation

Intercept local file links into a Next page/overlay that preserves the mounted parent chat, position and draft. Use browser-native rendering/file behavior except for Markdown, which must reuse the exact chat Markdown renderer, styles, copy actions and link/image interception with file-relative resolution.

Use a back arrow and basename header. A deliberate left-to-right drag of roughly one-third viewport width should navigate back; preserve vertical scroll/selection and reduced motion. Verify representative Markdown, image, PDF/other formats and long filenames at narrow/desktop sizes. Intercepted-route/native-frame design was investigated; no code exists yet.

### Installed PWA composer placement — pending implementation

Only standalone iOS PWA layout should change; normal browser placement stays as-is. Any freed space must expand the transcript viewport rather than leave a translated dead strip.

The existing bottom padding is `max(16px, env(safe-area-inset-bottom))`. At a 34px inset the composer already sits at the reported exclusion boundary. A safe bounded candidate is removing only the 16px minimum in standalone mode while preserving the actual inset; that would gain 16px at zero inset but would not lower a closed 34px-inset portrait layout. It was not implemented. Validate keyboard, safe area, orientation, focus and touch targets; do not claim physical-iPhone proof from emulation.

### New-content fade — pending implementation

Apply a very quick opacity-only reveal to newly added/changed visible content. Preserve prior text, Markdown, selection/copy/images and scroll anchors. Do not re-fade the whole message per delta, replay history on virtual remount, queue animation backlogs or reintroduce custom scrolling. Respect reduced motion. Only design/source inspection was completed.

### Budget/token analysis — pending implementation

Build a simple callable procedure/CLI for explicit start/end times and a local-day shortcut. Cover main/delegate/native-child Codex and Claude Code sessions, including cloud usage when available. Keep per-chat/per-model totals and parent relationships.

Retain every available input/cache-read/cache-write/output/reasoning category, units and provenance; mark subset categories to avoid double counting. Deduplicate resumed/forked/cumulative records. Distinguish billed charges, token-price estimates and subscription usage; retain pricing date/source, currency/tier and missing coverage.

The proposed CLI was `npm run usage -- --start ISO --end ISO --timezone IANA` or `--day YYYY-MM-DD`, with JSON/Markdown output and reusable `src/server/usage-*` modules. No collector or CLI code was saved. An earlier one-off October 19 report remains locally in `DX/POCKET_USAGE_2026-10-19.{md,json}`; it is not a current-day total or the requested reusable tool.

## Blockers and integration boundaries

- Resumed workers failed with HTTP 401 from the local proxy at `http://127.0.0.1:10100/v1/responses`: **OpenAI account pool has no usable account credential**. Resolve credentials before any authorized worker resumption; do not repeatedly replay failed or unknown deliveries.
- All current workers were closed and their queued work canceled after the stop. Saved sessions and worktrees remain. Stop instructions take precedence over earlier automatic recovery guidance.
- Browser/build runs encountered severe shared-machine contention. If work is authorized later, retain the shared `/tmp/pocket-browser-qa.lock` resource discipline; do not widen test timeouts/tolerances to conceal it.
- Steering and summary WIP both touch the delegation DB/owner. Summary and silent-notification WIP both touch visible projection. File viewer/fade may later share Markdown integration. Resolve actual conflicts coherently; do not replace whole modules with older branch copies.
- The consolidated TanStack adapter still uses `_didMount` / `_willUpdate`, matching the installed official adapter's lifecycle but relying on undocumented core methods. Existing passing flow evidence does not remove that dependency caveat.
- Native EventTarget listener failures/rejections surface on a later uncaught tick, unlike EventEmitter synchronous throws. This previously documented contract change remains relevant.
- Keep strict typed lint/format/type policy and the authorized custom-rule changes. No baselines, suppressions, unsafe assertions or authored-source exclusions as a shortcut. Integration tests should exercise whole flows; no unit tests.
- No new implementation checks, builds, CI runs, merges, deployments or restarts were performed to create this archive. Local private state, credentials, uploads, databases, raw logs and dependency/build caches were not published.

## Saved delegate identities

These current-task delegates are closed. Their saved identities remain available for inspection if Juan later authorizes resumption. Preserve existing work and inspect uncertain outcomes before any new assignment.

| Task                    | Side Pocket ID                         |
| ----------------------- | -------------------------------------- |
| Steering / prompts      | `92ae67a2-2467-425d-a4d4-38680b678290` |
| Reconnect investigation | `5f5b6d17-8f0b-4889-a9ca-f390e706eb4f` |
| Smaller spinner         | `a4254990-8215-40e9-b547-988840640f8b` |
| App-server controls     | `923cf7c6-9a56-4768-a733-c3e0aec2bb9f` |
| File viewer             | `4b191b25-7180-4869-92f6-44b102ab2075` |
| PWA placement           | `5942f492-e59d-47ec-bba9-1afcd44524a6` |
| New-content fade        | `760445d1-1ad2-4ef4-851f-955aefd29862` |
| Delegate summaries      | `bb2ed6ea-531a-4800-a389-93056a452fd8` |
| Usage budget            | `405c9925-2fec-40e6-96cb-7da0c7375461` |
| Silent notifications    | `530ea013-141c-4661-939d-b8a850597418` |

The completed composer-focus worker `6650b764-e6b7-4c9a-acd9-7fd2860c585b` is idle. Transcript-tail WIP was owned by main Pocket. The two-round independent reviewer is also idle; no new review is queued.

## Completed or canceled work

The consolidated snapshot preserves the earlier typed cleanup, self-contained root policy, one Playwright configuration, shared renderer/renderability cleanup, uploads/file-row corrections, saved MCP/dynamic tool projection, copy actions, agent browser, native virtualization, spinner tooling, event-driven eight-slot delegation, focus locking and restart events.

Independent duplication/dead-code review completed in two rounds. All three confirmed findings were fixed and verified; there is no pending third review round.

Custom smooth scroll clocks, staged long-distance seeks, held extents, press leases, elaborate footer choreography and their dedicated tests were explicitly canceled and removed. They are **not pending tasks**. Historical branches that contain them are archives only.

## Historical branch archive

Other pre-existing local feature branches and the detached review snapshot were preserved under `archive/stopped-2026-10-20/`. These preserve lineage, including superseded experiments and a held config-helper tranche. They are not merge recommendations. Use the consolidated snapshot as the completed implementation baseline.

The exact branch-to-SHA archive index follows.

| Original branch / snapshot                  | Published archive branch                                                                                                                                                                 | Revision                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `feat/agent-browser`                        | [archive/stopped-2026-10-20/feat/agent-browser](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/agent-browser)                                               | `40fe5913720d064f40d533f7e055534b22d7c39c` |
| `feat/chat-virtualization`                  | [archive/stopped-2026-10-20/feat/chat-virtualization](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/chat-virtualization)                                   | `3dbd6ad69c14a15db98580d7ab8127fcd142506d` |
| `feat/copy-action`                          | [archive/stopped-2026-10-20/feat/copy-action](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/copy-action)                                                   | `4aa210e5b88f44357572630cd365cbb8dc0aaf2d` |
| `feat/custom-spinner`                       | [archive/stopped-2026-10-20/feat/custom-spinner](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/custom-spinner)                                             | `6f5e5eb89d2dc029cfbc14595ff2f3fbfc27b6d8` |
| `feat/event-driven-delegation`              | [archive/stopped-2026-10-20/feat/event-driven-delegation](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/event-driven-delegation)                           | `17ea401e77d247e75a3b3d867c7dedcc82a69582` |
| `feat/file-uploads`                         | [archive/stopped-2026-10-20/feat/file-uploads](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/file-uploads)                                                 | `e9bcd92386898836a59d00cf417ac98e01ceacab` |
| `feat/restart-notice`                       | [archive/stopped-2026-10-20/feat/restart-notice](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/feat/restart-notice)                                             | `44a47dbee6c5cb8fe62e124f598ce1a610ec9f72` |
| `fix/attachment-file-rows`                  | [archive/stopped-2026-10-20/fix/attachment-file-rows](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/attachment-file-rows)                                   | `32b5597ed62b30f9debce78ab1dcbe2272c29a25` |
| `fix/composer-attachment-details`           | [archive/stopped-2026-10-20/fix/composer-attachment-details](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/composer-attachment-details)                     | `427fffea4100df78fa0068f521cd193e5ca09b29` |
| `fix/final-typed-cleanup`                   | [archive/stopped-2026-10-20/fix/final-typed-cleanup](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/final-typed-cleanup)                                     | `86b9babfd2c3064b0a17c9b91ea50d4ab429af98` |
| `fix/focused-input-scroll`                  | [archive/stopped-2026-10-20/fix/focused-input-scroll](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/focused-input-scroll)                                   | `84700fdd04cf8da206d23ac35919fb9ed775b949` |
| `fix/self-contained-typed-config`           | [archive/stopped-2026-10-20/fix/self-contained-typed-config](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/self-contained-typed-config)                     | `c9060dd93666a5340cdd190540f8ea3bfc2fe5a7` |
| `fix/shared-chat-spacing`                   | [archive/stopped-2026-10-20/fix/shared-chat-spacing](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/shared-chat-spacing)                                     | `0e81e2a185ea7e952ffca5709446e3f6f0833ab0` |
| `fix/single-image-delivery`                 | [archive/stopped-2026-10-20/fix/single-image-delivery](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/single-image-delivery)                                 | `765e93c6817d5d4f5d3ad98fd55574ce145f8c66` |
| `fix/steady-thinking-spinner`               | [archive/stopped-2026-10-20/fix/steady-thinking-spinner](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/steady-thinking-spinner)                             | `ba35b32ae25f8856536d1ab4c79b8747cb06ead2` |
| `fix/typed-config-coverage`                 | [archive/stopped-2026-10-20/fix/typed-config-coverage](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/fix/typed-config-coverage)                                 | `a913918216662cce3aba60be1c84cf02e007b195` |
| `virtualization-before-main-rebase-7735a8f` | [archive/stopped-2026-10-20/virtualization-before-main-rebase-7735a8f](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/virtualization-before-main-rebase-7735a8f) | `7735a8f9a0e51e3d94d18911c0d80f2064de5c7f` |
| `detached combined review`                  | [archive/stopped-2026-10-20/combined-review](https://github.com/jdeurt/codex-pocket/tree/archive/stopped-2026-10-20/combined-review)                                                     | `c7d8457cf288516dfc10b2b06716d15a442a1ee0` |

## Full requirements and approved prompt text

See [POCKET_FOLLOW_UPS.md](POCKET_FOLLOW_UPS.md) for the retained task requirements and [POCKET_PROMPT_DRAFTS.md](POCKET_PROMPT_DRAFTS.md) for the approved prompt blocks. This handoff is authoritative for progress, publication and stopped state.
