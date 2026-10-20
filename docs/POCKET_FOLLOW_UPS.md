# Pocket follow-up tasks

All implementation, delegates, tests and deployments are stopped at Juan's request
on October 20, 2026. Only snapshot commits, branch publication and the handoff were
authorized after that instruction. Do not resume from earlier approval or recovery
instructions without new direction from Juan.

Current progress and published development branches are recorded in
[the stopped-work handoff](POCKET_WORK_HANDOFF_2026-10-20.md).
The last recorded successful deployment is `86b9bab`; local consolidated `main` is
`38c5ac6`, including an undeployed composer-focus fix.

The current batch includes spinner and image fixes, uploads, agent browsing and
read-only chats, standard library virtualization, shared spacing,
custom-spinner tonal adjustment, copy actions and prompt guidance, focused-input
scroll locking, eight-slot event-driven delegation, header-logo removal, and the
restart notice. These features belong to the consolidated implementation; their historical task branches are archived in the handoff.

Juan explicitly added these small preview corrections to the current batch:
remove redundant X controls from both agent views; remove the read-only agent
header's secondary metadata line; use text-only pending attachment cards showing
filename/type/size/status with slightly increased, consistent left padding.

## Current-batch review gate — approved

- [x] **Independent duplication and dead-code review, with at most three rounds.**
      Start after the current lint/type/format fixer finishes. Complete this gate
      before final current-batch acceptance/deployment and before steering work.
  - Create a separate Codex reviewer using Sol (`gpt-6.1-sol`) with HIGH reasoning.
    Review the fixer's same branch in `pocket-final-typed-cleanup`, pinned to its
    completed commit. Keep the branch stable during each review. The reviewer
    reads and reports; the existing fixer owns source changes.
  - Apply only the duplication and dead-code portions of the code-review skill.
    Investigate the whole authored project, including supporting scripts/tests
    and unchanged code needed to establish dependencies. Do not turn this into
    another general style or feature review.
  - Scan exact, renamed, and near-miss duplication (Types 1/2/3), including
    JavaScript/TypeScript cross-format matches, starting at similarity **0.7**.
    Preserve normal generated/vendor exclusions and report scanner limitations,
    truncation, thresholds, and coverage. Inspect both fragments and their callers
    before treating a scanner lead as an actionable finding.
  - Investigate dead-code leads through real references, exports, framework/CLI
    entry points, dynamic loading and test coverage. Include dead work and obsolete
    parallel implementations where supported by evidence. Unused-name counts and
    scanner confidence alone are insufficient evidence for deletion.
  - Favor root fixes that improve ownership and clarity. Preserve intentional
    similarities when sharing them would couple distinct contracts or create an
    awkward abstraction. No quota of deletions or helpers and no rule weakening.
  - Each round: reviewer reports confirmed findings with paths/lines, supporting
    evidence, practical impact and a coherent remedy; main Pocket sends them to
    the fixer; fixer addresses them and runs appropriate focused whole-flow checks
    plus lint/type/format gates; reviewer verifies the reported fixes. Pin each
    result and record which findings are resolved, rejected with evidence, or open.
  - Repeat this review/fix exchange for at most **three review rounds**, stopping
    earlier if no actionable findings remain. Verification of a round's findings
    is part of that round, not an unlimited new review pass.
  - If unresolved findings or review blockers remain after round three, pause all
    project work and report the exact current commit, remaining findings, evidence
    and review limitations to Juan. Do not start round four, deploy, or begin
    steering work without his direction.
  - Status: complete in **two rounds**. Sol/High reviewer
    `ae8f16c9-6305-4919-96e3-adb20dd7cf5b` confirmed three P3 findings in round 1:
    duplicated sequential offline RPC transport, a duplicated activity anchor
    assertion, and unused `DelegationMail`. Fixer
    `92ae67a2-2467-425d-a4d4-38680b678290` resolved all three in `f05961b`;
    independent verification closed them. Round 2's refreshed whole-project scans
    at `38bc9a4` found no open duplication/dead-code findings. Evidence remains in
    `pocket-final-typed-cleanup/.local/independent-review/round-{1,2}/`.
  - Deployment is complete at `86b9babfd2c3064b0a17c9b91ea50d4ab429af98`,
    including the append-follow repair and two installer fixes. Formatting, typed
    lint, root/worker types and the production build pass. Deployment verification recorded local and Tailscale HTTPS 200 and the original chat connected with Sol/High and retained settings. The reviewer is idle. All later implementation is now stopped.

## Approved steering scope — stopped

- [ ] **Default delegate steering and the approved prompt reorganization.** Start
      this bundled task only after new authorization to resume. Its previously approved
      priority and requirements are retained below.
  - Implement direct mid-turn steering through supported harness APIs. Steering
    is the default for corrections, answers, changed requirements, and other
    messages concerning the delegate's current task.
  - Queuing requires explicit opt-in for a DISTINCT SEPARATE task to run AFTER the
    current task finishes. Same-task follow-ups must not become queued assignments.
  - Steering an active turn does not consume a new execution slot or wait behind
    queued work. Starting a new turn on an idle delegate still obeys execution
    capacity. Preserve identity, history, permissions, and in-progress work.
  - Expose accepted/delivered/unsupported/failed outcomes honestly. Do not silently
    fall back to queuing. Check Codex and Claude native capabilities separately.
  - Allow explicit superseding/cancellation of stale queued assignments, retaining
    an audit trail and idempotency. Preserve unrelated work and inspect uncertain
    outcomes instead of replaying them.
  - Apply the approved [Pocket prompt blocks](POCKET_PROMPT_DRAFTS.md) together with
    the implementation. Main Pocket explains messaging, default steering, and the
    distinct-task-only queue policy. Side Pocket contains NO steering/queuing
    guidance; its harness handles delivery. This omission is explicitly approved.
  - Preserve base Codex/Claude instructions, runtime permissions, identity
    substitution, restart/recovery semantics, silent-idle behavior, image/copy
    guidance, and scheduled-task behavior. Do not inject prompts as ordinary user
    messages. No runtime prompt has been changed yet.
  - Verify real fake-harness flows for active reasoning/tool execution, completion
    races, idle versus active capacity, superseded queues, retries and recovery.
  - Status: stopped. Published branch `feat/delegate-steering` at `a8b9477`;
    WIP implementation; final verification and integration incomplete. See the handoff for remaining work and evidence.

## Stopped and pending follow-ups

- [ ] **Expose useful Codex app-server controls to Pocket.** Review the installed
      app-server protocol and identify capabilities Juan may want Pocket to call
      directly. Use Pocket's existing authenticated connection and native APIs.
  - Let Pocket inspect and change its own thread's model and reasoning effort.
    Return the effective settings after a change and state when they take effect.
    Define persistence across reconnects/restarts without changing unrelated chats
    or explicitly configured delegates.
  - Let Pocket inspect its context window: model capacity, reported token usage,
    remaining capacity or utilization when available, and compaction state/events.
    Distinguish reported values from estimates and unavailable data. Reuse the
    budget/token-analysis task's usage contract rather than build a second counter.
  - Review other useful candidates: available models and supported effort levels,
    effective session settings, account/rate-limit status, thread/turn status,
    compaction, queued-message inspection/cancellation/reordering, and background
    terminal status. Check actual installed protocol support and relevant Codex
    versus Claude differences; these are candidates for review, not blanket
    authorization to expose every app-server method.
  - Present a concise capability list with each control's purpose, scope, side
    effects, and limitations so Juan can choose additional access. Keep read-only
    inspection straightforward and mutations explicit, with honest delivery results.
  - Prefer a small typed tool surface over arbitrary RPC passthrough. Preserve
    thread identity, runtime permissions, active work, and existing message/history
    handling. Routine setting changes should use the live connection without a
    service restart or temporary debugger attachment when the protocol supports it.
  - Coordinate queue/steering controls with the approved first post-deployment task
    so there is one delivery mechanism and one source of queue state.
  - Status: stopped. Published branch `feat/app-server-controls` at `86b9bab`;
    planning/protocol inspection only; no task implementation. See the handoff for remaining work and evidence.

- [ ] **Open local file links in a phone-readable file viewer.** Intercept chat
      links pointing to filesystem files instead of navigating to inaccessible local
      paths. Open a Next.js page that serves/wraps the file content: Markdown, images,
      PDFs, and other file types. Always use native/browser rendering and normal file
      behavior. Do not implement custom rendering for any file type except Markdown,
      for which custom rendering is explicitly allowed. If the browser cannot display
      a format, retain its native file/download behavior rather than build a viewer.
  - Markdown must reuse the exact shared chat-message renderer and styles, not a
    separate implementation: identical spacing, typography, tables/code blocks,
    copy-action interception, link interception, image embedding, and other
    supported chat rendering behavior. Resolve file-relative links and images
    against the viewed file's directory while retaining the shared presentation.
  - Minimal header: a back arrow returning to the prior chat view and the file's
    basename (the last path component), rather than the full filesystem path.
  - Preserve the prior chat position and draft when returning.
  - Support swipe-back from left to right with an animated return to chat. Require
    a deliberate horizontal drag of roughly 33% of the viewport width; tiny or
    short swipes must not navigate and should settle back smoothly. Preserve
    vertical scrolling, text selection, and native file interactions; respect
    reduced-motion preferences. Keep the header back arrow available as well.
  - Use good mobile UI practices: no extra explanatory text or decorative copy;
    consistent text spacing and alignment; sensible padding and touch targets;
    no accidental horizontal/page overflow. Long filenames must truncate or wrap
    deliberately without displacing the back control. Content must fit or scroll
    appropriately for its native format and available viewport.
  - Verify narrow-screen and desktop behavior across representative Markdown,
    image, PDF, and other files, including long filenames, before completion.
  - Status: stopped. Published branch `feat/phone-file-viewer` at `86b9bab`;
    planning only; no viewer code. See the handoff for remaining work and evidence.

- [ ] **Lower the composer slightly in iOS installed PWA mode only.** The current
      website/browser placement is good; preserve it. Investigate the bottom iOS safe
      area/home-indicator exclusion boundary, existing composer padding, viewport and
      keyboard handling, and applicable CSS safe-area/display-mode rules. In standalone
      PWA mode, position the input slightly lower relative to that boundary without
      overlapping the home indicator or keyboard. Start by trying a 16px downward
      adjustment (matching the current block gap), then verify it against the actual
      safe-area boundary. The chat viewport above must expand by the space freed:
      leave no dead strip and do not merely translate the composer visually while
      retaining its old layout footprint. Prefer a minimal PWA-only CSS adjustment to
      layout padding/insets; avoid a large layout or scrolling rewrite.
  - Verify installed/standalone mode versus normal browser mode, keyboard open and
    closed, focus/blur, orientation changes, scrolling and available touch targets.
  - Status: stopped. Published branch `feat/pwa-composer-inset` at `38c5ac6`;
    layout investigation only; no adjustment implemented. See the handoff for remaining work and evidence.

- [ ] **Quick fade-in for newly arriving chat content.** Apply coherent motion to
      newly received chat text and content updates. For streaming, animate only the
      newly added/changed visible
      portion between the prior and updated state with a very quick fade-in; do not
      re-fade the entire message or previously visible text on every update. Keep it
      snappy with no artificial stream delay or queued animation backlog.
  - Reuse shared motion timing/easing conventions where appropriate. Preserve
    Markdown rendering, selection, copy actions, image embedding, and stable
    layout/scroll anchors. Do not replay entry animations merely because a
    virtualized historical row remounts. Respect reduced-motion preferences.
  - Verify rapid streaming, Markdown edits/reflow, new messages, user scrolling
    away, and virtualization; no flashing, repeated fades, scroll jumps, or
    animation that fights user gestures.
  - Custom smooth bottom-settling was cancelled and removed from the current
    batch. This deferred text animation must not restore that scrolling machinery.
  - Status: stopped. Published branch `feat/new-content-fade` at `38c5ac6`;
    design/source inspection only; no fade code. See the handoff for remaining work and evidence.

- [ ] **Summarize delegate messages for the UI through one-shot Codex.** For each
      parent-bound delegate message/status/result/request, run a separate lightweight
      Codex summarization invocation with a fixed transformation prompt and the
      message text. Produce a short, heavily paraphrased high-level description that
      preserves essential feature names/key terms and actionable meaning. The user
      requested a plan first to confirm understanding; this is not implemented.
  - Classify from actual message semantics/envelope: update, question, completed,
    failed/blocked, or action/approval request as appropriate. A progress report
    that says tests passed must not be promoted to task completion. Preserve the
    actual question/decision when an answer is needed.
  - Exact UI: only a small message-bubble icon followed by the streamed paraphrase
    text. No delegate name, type label, heading, badge, timestamp, extra controls,
    or explanatory copy. Classification may inform the paraphrase internally but
    must not add visible UI. The original remains in the existing delegate history
    and parent delivery, not an additional expansion control on this element.
  - Use muted styling for the icon/paraphrase, with the paraphrase at exactly the
    normal assistant-message text size, not the smaller thinking/status font size.
  - Make the summary itself clickable/tappable: open the sending agent's existing
    read-only chat view directly. Reuse the agent browser's navigation and renderer;
    add no separate message viewer or extra visible control. Support keyboard
    activation and preserve the parent chat's scroll position and draft on return.
    Opening a summary must not send input or resume the agent's work.
  - On arrival, immediately show a small message-bubble icon for the incoming
    delegate report. Stream the one-shot Codex paraphraser's response into the
    summary beside it as tokens arrive; do not wait for the entire summary before
    displaying it. Keep the icon stable and apply shared text/spacing/motion
    conventions without a large empty placeholder. The displayed stream is the
    paraphrase, not the raw report. Convey a question or failure naturally in the
    summary text when relevant, without separate labels.
  - Deliver the full original message to the parent unchanged; summarization is
    a display projection and must not replace the work evidence or instructions.
  - Treat supplied report text as data to summarize, not instructions to execute.
    The one-shot summarizer should not receive task tools or mutate conversations.
  - Run asynchronously, persist/cache by stable message ID/content, avoid repeated
    calls on refresh/reconnect, and retain a readable fallback if summarization
    fails. Do not block parent delivery or fabricate a summary on failure.
  - Show concrete examples and agree the prompt/output contract before building.
  - Status: stopped. Published branch `feat/delegate-summaries` at `27151b1`;
    partial UI/cache/projection WIP; native invocation unresolved. See the handoff for remaining work and evidence.

- [ ] **Budget and token analysis for main chats and delegates (deferred).** Provide
      a simple tool/procedure callable by Pocket or Codex that reports usage and cost
      over an explicit start/end time, with a local-day shortcut. Cover Codex and
      Claude Code (including cloud-hosted coding sessions when usage is available),
      main Pocket, Side Pockets, and native harness subagents. Preserve parent/child
      relationships and show main versus delegated totals, per chat and per model.
  - Record input, uncached input, cached input/cache reads, cache writes, output,
    reasoning and every other available usage category, with units and source.
    Mark subset categories so reasoning/output or cached/input are not added twice.
  - Include session IDs/names, harness/provider, model changes, start/end times,
    timezone, incomplete/running status, and missing or unavailable usage. Deduplicate
    forks, resumed sessions, cumulative counters and repeated delivery records.
  - Report spend per chat/model and aggregate totals. Distinguish provider-reported
    billed charges from token-price estimates and subscription/credit usage;
    retain pricing source/date, currency, service tier and unresolved pricing.
  - Prefer the simplest reliable local procedure/tool, reusing existing usage
    records and the codex_spend routine where suitable. Database persistence is
    optional, not a requirement: choose a lightweight file/report or existing
    store if that avoids orchestration. Make repeat invocation and export easy.
  - Define how to collect/refresh data for both harnesses, including sessions not
    currently running, and expose coverage gaps rather than silently counting zero.
  - Status: stopped. Published branch `feat/usage-budget` at `38c5ac6`;
    collector/CLI design only; no collector code. See the handoff for remaining work and evidence.

- [ ] **Suppress notifications for turns with no user-visible message.** A turn
      finishing is not sufficient reason to notify. When Pocket processes a delegate
      update or otherwise ends silently, send no notification if there is no actual
      user-visible assistant message. Empty or whitespace-only final messages and
      hidden bookkeeping/tool events must not trigger notifications.
  - Base notification eligibility on actual visible message content, including
    meaningful non-text content where applicable. Preserve notifications for
    real messages and existing actionable questions/approval requests.
  - Verify silent turn completion, empty final responses, delegate-only updates,
    normal visible responses, and reconnect/replay without duplicate alerts.
  - Status: stopped. Published branch `feat/silent-notifications` at `0c97dfe`;
    partial source WIP; verification unfinished. See the handoff for remaining work and evidence.

## Current visual fixes

- Agent-list flashing/reconnect investigation is saved as tests-only WIP `ff6166b`
  on `fix/agent-reconnect`; native discovery exceeded the browser timeout. No
  product fix or completed regression result exists. Work is stopped.

- Stable activity/status/agent spacing WIP is saved as `273cbd8` in
  `pocket-transcript-tail`; work and verification are stopped.
  Preserve the 44px press target while removing added layout height; status text
  changes must retain a single line and stable geometry.
- Composer focus anchoring: worker `6650b764-e6b7-4c9a-acd9-7fd2860c585b`
  completed `9af9126`, integrated locally as `38c5ac6`; deployment pending. Native TanStack end-follow
  handles viewport shrink without moving a history reader.
- Smaller custom spinner: worker `a4254990-8215-40e9-b547-988840640f8b`
  committed `bb55ba9`, a 28px image in the existing 32px slot; default SVG remains
  16px. Final WebKit verification is unfinished and stopped.
- The requested original Kirby GIF is selected live; preserve this preference.

## Completed follow-ups

The previous review/deployment gate is complete. New follow-ups above remain open
and stopped. Snapshot publication does not complete implementation or acceptance.
