# Pocket handoff completion — October 20, 2026

Juan authorized resuming the stopped handoff, retaining original delegate reports, adding JSCPD at similarity 0.7, and merging through a development branch. Integration uses `finish/pocket-handoff-2026-10-20`, starting from `4911d73` and merging the six saved implementation branches. The composer-focus fix was already in that baseline. The original working checkout and live private state were preserved.

## Delivered behavior

- Current-task delegate messages steer by default. Explicit later assignments queue. Selected unsent assignments can be canceled or superseded with an audit trail. Active Codex steering uses the existing slot and expected turn ID; Claude reports unsupported active steering. Unknown sends are not replayed.
- Same-parent agent discovery refreshes in the background while serving its last verified catalog. Cold discovery and ownership changes still require verified results. Repeated reads coalesce; timeouts were not increased.
- Agent presence, long/empty activity text and the notification banner retain stable footer geometry. The custom spinner is 28px inside its existing 32px slot; the default SVG remains 16px. The previous focus/end-follow repair remains intact.
- Incoming delegate reports display their original text and open the sending agent's read-only conversation. Questions, choices, blockers and full parent delivery remain intact. No summarizer inference runs.
- Blank, parser-hidden, bookkeeping-only and commentary-only completions return before claiming notification receipts. Visible replies/images retain foreground suppression and deduplication.
- Parent-only model/effort controls reuse the existing serialized connection, read back native settings, and persist them across reconnects. Token accounting and observed compaction are exposed; exact remaining context stays unknown. See [the capability matrix](POCKET_SESSION_CONTROLS.md).
- Local files open through an intercepted full-screen route retaining the parent draft and position. Markdown uses the chat renderer and relative file resolution; images/PDFs use native frames, and unknown types offer downloads. The header has a 44px back target and an 8px gap. A dedicated empty edge strip owns deliberate swipe-back without capturing links or selected text.
- Installed iOS layout uses `max(0px, safe-area-inset-bottom - 16px)` below the composer. A 34px reported inset leaves 18px of padding, moving the input down 16px and giving that space to the transcript. Zero and small insets clamp to zero; the reserved status row keeps its 44px height and 10px input gap.
- Newly arriving literal Markdown and code suffixes get a 100ms opacity reveal. Prior content stays opaque, animations cancel rather than queue, virtual remounts do not replay them, and reduced motion disables them. React's pre-mutation selection snapshot preserves unchanged selected text through Markdown node replacement.
- `npm run usage` reads native Codex/Claude records for an explicit interval or local day. It retains category/provenance/parent information, deduplicates resumed/forked/cumulative records, and separates native reported costs from optional dated price estimates and unknown billing/subscription charges.
- `.jscpd.json` sets similarity 0.7 with identifier/literal/annotation normalization, two gap lines and JS/TS cross-format matching. Authored source and tests are included.
- Complete installed Codex/Claude interface snapshots and reusable protocol simulators support offline testing. Normal `npm test` uses an empty home/PATH and no inherited credentials. Shared conformance flows also pass against isolated real instances. The [simulator guide](POCKET_SIMULATORS.md) distinguishes stateful behavior, explicit scenarios and native-calibrated coverage.

## Verification

Initial handoff verification passed 176 browser tests with four expected skips. Additional geometry coverage passed ten cases with two WebKit-only skips in Chromium. That initial version retained a 34px simulated bottom inset. Native files, Markdown, swipe thresholds, selection retention, streaming code and virtual remounts passed on desktop/phone Chromium and WebKit.

Follow-up layout checks measure the updated 34px-to-18px PWA inset, the matching 16px transcript gain, rotation and keyboard bounds, and the 16px gap from the last visible transcript component to the status text. Fractional message heights are retained in the virtualizer to prevent accumulated rounding error; the scroll fade is disabled at the transcript end so the final component remains visible.

The complete server/workflow suite passed 88 tests in the isolated offline environment. Formatting, zero-warning lint, strict types and the production build passed. The same complete suite also passed while the SDK's bundled native executable was temporarily removed from this worktree and then restored.

The usage CLI also read the current local native records successfully: 62 source files, 204 selected accounting records, and no malformed lines. This proves local-record collection, not complete cloud or billing coverage. Private usage content remains in ignored local artifacts.

## Review and limits

JSCPD's configured structural/normalized/gap clone scan and full dead-code scan completed. Scanner output is a lead list, not a deletion list. Similar SQL query chains retain different schemas and ownership contracts; test geometry/setup assertions retain their distinct scenarios. Next route exports, React lifecycle methods, constructors and test-only fixtures flagged as unused are runtime/framework entry points or exercised test code. The final scans reported 1,728 clone candidates and 776 dead-code candidates. The newly retained generated native schemas dominate the clone count; their repeated definitions are preserved as exported. New authored-code leads were independent mapping tables and test cleanup blocks. One unnecessary simulator-only export was removed. No actionable new duplication/dead-code finding remained after source and caller review. Semantic-model analysis is not configured. Full JSON reports are retained under ignored `.local/review/jscpd`; the human-readable dead-code report is truncated.

Browser proof uses Chromium/WebKit phone and desktop emulation, measured DOM rectangles, scroll gaps, hit targets and explicit keyboard/standalone simulation. It does not establish physical-iPhone keyboard or safe-area behavior. Native-control and delegation flows use isolated protocol fixtures. Simulator calibration additionally made authenticated inference calls in disposable native sessions; no live push notification was sent. Production is not restarted or deployed by merging this branch. The live Kirby selection and private stores remain untouched.

The multiple-main-Pockets menu is a separate Linear follow-up. It is not implemented in this batch.
