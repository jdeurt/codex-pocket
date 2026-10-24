# Transcript layout reference

Use these measurements when changing chat layout. Verify them with Playwright geometry and computed styles across empty, active, streaming, and expanded states. Screenshots help review appearance but do not replace measurements.

## Status and composer

The status row is the last item inside the transcript's scroll container. It scrolls away when reading earlier messages and reserves **44px** whether its contents are visible or absent.

At the transcript end:

- The bottom of the last visible transcript component is **24px** above the status text's line box.
- The reserved status row ends **10px** above the composer area.
- The thinking indicator, one-line status label, and agents hint share a vertical center. The status label starts with a capital letter.
- The agents button has a **44px** touch target without negative vertical margins.
- The default spinner's visible **16px** bounds align with transcript text, with **8px** before its label.
- Custom spinner images remain **28px** wide. Both spinner types use a **32px**-high slot; horizontal space fits the displayed indicator.

Short conversations align to the bottom. The scroll fade ends at the composer boundary and disappears at the transcript end. Notifications, errors, and attachments belong to the composer area below the status row. Empty, thinking-only, agents-only, and combined states keep the same vertical geometry.

The transcript has a centered 960px maximum width; the composer has a centered 736px maximum width. Phone layouts retain their existing gutters. Classic desktop scrollbars reserve symmetric gutters so the transcript and composer stay centered together. The virtual footer keeps one stable identity as messages arrive so its measured status height survives appends. A transcript-owned Zustand store holds the reader’s follow preference and gesture state. Committed content growth follows the end, including new rows before the stable footer and streamed text growing within an existing row. Scrolling up pauses following; reaching the end or choosing “Jump to latest message” resumes it. Native measurements remain owned by the virtualizer. Overlays suspend following while covered and retain the prior following preference when closed.

The voice spectrum uses fixed **4.5px** bars and **4px** gaps, fitting only whole bars within its available width. During shutdown, its bars turn gray and the composer shows an “Ending call…” spinner.

## Reports, attachments, and navigation

Delegate reports start collapsed, with a single-line preview truncated to the message's allowed width. Expansion uses normal message spacing. Opening a read-only Side Pocket preserves the parent's draft and reading position. Pending history uses skeletons; error and empty states keep explanatory text.

Only reports carrying verified `final: { commandId, outcome: "completed" }` provenance receive the incoming-agent indicator and final-report disclosure. Interim and legacy reports remain readable without that indicator. The integrated harness implementation at `186f827` supplies durable command association and exactly-once selection; delivery status alone cannot establish finality.

The optional `Conversation.footer` slot matches Browsing’s loading-content contract. Agent list/loading state and the optional `AgentTranscript.isHistoryLoading` schema remain owned by Browsing.

Expanded report bodies, activity messages, and tool details collapse when their non-interactive content is clicked. Links, buttons, focusable controls, and text selection keep their normal behavior. The shared collapsible panel owns the existing activity transition and reduced-motion behavior. Activity message padding accounts for the trigger's existing 10px below its label, keeping the visible message gap at 16px.

Main-Pocket tool visibility uses the central Settings `showToolCalls` preference through `usePocketSettings()`. The central Settings implementation at `f09c33e` is integrated, including the shared hook, public schema, `/api/settings` route, and persistent toggle. Hiding tool details preserves ordinary messages and tool-produced images. Both views use `ToolMessage`, with display-only `toolLabels` projected from explicit native commands and file-change operations. Pi call labels also survive completion and saved-history reload. Native write tools that omit creation-versus-replacement metadata retain a generic label. Private tool argument objects remain on the host.

Recoverable native errors use `Snapshot.connectionRetry`, scoped to a native turn and set only for an explicit `willRetry` signal. Resumed assistant output, completion of that same turn, or successful native connection rehydration clears the notice. Progress from another parent or turn cannot dismiss it, and fatal errors remain separate.

Sent attachment rows fit inside their message bubble, with an 80% maximum bubble width. File rows and following message text use 16px external gaps. Assistant image previews remain separate. Markdown table outlines belong to their horizontal scrolling container.

PWA composer positioning must account for the safe area and keyboard without leaving unused layout space. Test focus and blur, staged viewport restoration, history reading, and returning to the transcript end.

## Regression coverage

The current [workflow coverage map](test-suite.md) distinguishes automated guarantees from retired layout probes. Browser workflows under `tests/browser/workflows/` exercise independent conversations, actual native history, bounded mounted rows, reading-position restoration, read-only Side Pocket navigation, voice lifecycle and draft retention. The upload workflows retain original-byte and delivery guarantees.

The measurements above remain layout requirements. The lean replacement does not claim automated coverage for every pixel gap, nested-activity stress case, emulated keyboard transition or spinner appearance. Check relevant measurements when changing those surfaces, following the focused-development policy in [testing](testing.md).

Sending user messages use a dashed outline and queued messages use a dotted outline, both with transparent backgrounds and the same padding and dimensions as confirmed bubbles. Sending and queued states add no labels below bubbles. Delivery-uncertain and legacy handoff-uncertain notices remain visible. Attachment rows inside message bubbles have no inner padding; their icons align with the message text.
