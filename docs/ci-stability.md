# Browser CI stability investigation

JUA-56 investigates offline CI failures. JUA-73 establishes the agent testing and linting policy in [AGENTS.md](../AGENTS.md) before this investigation. Full-suite validation belongs to CI.

## Evidence

Three consecutive main-branch runs on October 21, 2026 passed the server/workflow suite and failed browser tests:

| Run                                                                            | Default browser collection | Realtime collection |
| ------------------------------------------------------------------------------ | -------------------------- | ------------------- |
| [39666274801](https://github.com/jdeurt/codex-pocket/actions/runs/39666274801) | 30 failed, 166 passed      | 7 failed, 68 passed |
| [39668745362](https://github.com/jdeurt/codex-pocket/actions/runs/39668745362) | 29 failed, 167 passed      | 1 failed, 74 passed |
| [39669998355](https://github.com/jdeurt/codex-pocket/actions/runs/39669998355) | 30 failed, 166 passed      | 1 failed, 74 passed |

The recurring failures include deterministic regressions as well as intermittent symptoms. A failure count alone does not establish flakiness. The variable failures included WebKit spinner persistence, agent-presence geometry, and realtime lifecycle cases. The common failures expose these causes:

## Send-button selectors

Realtime support changed the accessible label to `Send message; hold and swipe up for realtime voice`. Exact matches for `Send message` timed out in agent navigation, named Pockets, uploads, and attachment layout. The standalone layout test also queried the obsolete exact attribute before measuring geometry.

Send-action locators now match `^Send message(?:;|$)`, which accepts the action with optional instructions and excludes the realtime stop control. The same stale selectors in shared helpers, live tests, and update tests receive the same correction.

## Native clipboard platform

The WebKit clipboard test always pressed `Meta+V`, although CI runs on Linux. Device emulation does not change the host's keyboard shortcut. The test uses `ControlOrMeta+V` and retains its native paste/value assertion. It still tests the real clipboard rather than a mock.

## Transcript coverage measurement

`hasVisibleCoverage` considered message rows and activity triggers but omitted the transcript footer. At the end of a long history, the footer occupies visible space below the final message. In a focused Chromium reproduction, the last message ended about 66 pixels above the viewport bottom, causing the unchanged 64-pixel tolerance to reject a correctly populated viewport.

The helper includes actual footer children, as the activity coverage helper already does. The long-history scroll case failed before this change and passed afterward. No tolerances are widened.

## Nested activity scroll margin

The inner activity virtualizer cached its DOM scroll margin using an effect that depended only on its virtual origin, viewport reference, and suspension state. Expanding the activity changes the outer sizer and its initial bottom alignment. That moves the inner panel without necessarily changing its virtual origin. The stale margin makes a message above the reader appear below the fold to the size-adjustment predicate, suppressing the required scroll correction.

A focused Chromium reproduction measured a cached margin of approximately 657 pixels against an actual margin of 149 pixels. Loading an image above the saved reader anchor moved that anchor by exactly 210 pixels. The margin now refreshes when the outer end/offset or inner size changes, in addition to the original dependencies. The original image-growth, prepend, collapse, and reopen assertions pass, including three focused repetitions on the corrected code.

## Upload recovery and readiness

Once the stale selectors were repaired, focused upload tests exposed two further regressions. The fake harness could reconnect before Playwright observed the disconnected label, so the recovery test raced the outage. A restarted fake harness now waits for an explicit `reconnect` control. The test observes a disconnected/connecting state before releasing recovery, then retains the durable receipt, exactly-once delivery, and original-byte assertions.

The combined send/voice button also remained enabled for uploading or invalid attachments, although the send handler rejected those drafts. The button now uses the same upload-receipt readiness requirement, while an empty draft still permits the voice gesture. The upload recovery and gated upload/IME cases pass with their original disabled-state assertions.

## Spinner hydration

The intermittent WebKit spinner failure in run 39666274801 measured a 28-pixel image slot where the 16-pixel fallback was expected. The missing-asset test could accept the initial hydration fallback before the preference fetch mounted the image. It now waits for the selected asset's actual 404 response, then for fallback geometry to settle. The expected geometry and missing-file assertions remain unchanged.

## Realtime composer height

The geometry diagnostics in [run 39852479513](https://github.com/jdeurt/codex-pocket/actions/runs/39852479513) isolated the recurring WebKit failure. At a 320-pixel viewport, `unsent geometry draft` wraps in WebKit's font metrics: the textarea measures 68 pixels and its composer measures 82 pixels. Voice mode replaced that textarea with a fixed 44-pixel spectrum, shrinking the composer to 58 pixels and moving its top by 24 pixels. The Chromium single-line draft did not expose this case.

Both gesture and keyboard activation now capture the composer's actual height before replacing the textarea and preserve it for the voice session. The geometry regression explicitly uses a multiline draft and requires a multiline textarea before comparing the same rectangles and tolerances. Stopping voice restores automatic text sizing.

## Image-bearing bookmark restoration

The subsequent cleanup reduced ordinary history fixtures to 320 rows and exposed a 192-pixel restoration drift. The saved reader anchor itself contained an image. During reopen, that row temporarily shrank while the image decoded, putting its end above the saved offset. The native size-change heuristic then treated growth in that same row as preceding the reader and applied an unwanted correction.

Cached restoration now finds the saved anchor in the original measurements and compensates only rows before it. Explicit adjustment policies, including nested activity, keep precedence, and normal user scrolling retains its existing policy. The bookmark flow keeps its images and three-pixel tolerance, waits for media before capturing its initial position, and passed three focused repetitions after the correction.

## Reproduction and validation

Select exact cases rather than a feature collection:

```sh
npx playwright test tests/browser/virtualization.spec.ts --project=virtualization-chromium-desktop --grep 'large single-turn history'
npx playwright test tests/browser/virtualization-activity.spec.ts --project=virtualization-chromium-desktop --grep 'a thousand activity messages' --repeat-each=3
npx playwright test tests/browser/pockets.spec.ts --project=pockets-chromium-phone --grep 'named Pockets preserve separate conversations'
```

The development VM uses its installed `/usr/bin/chromium` through temporary, ignored Playwright configuration overrides. Those overrides select only the relevant project and fixture server; they are not CI configuration changes. WebKit is unavailable locally, so its validation relies on CI.

Realtime CI retains failure traces, and both browser jobs upload failure results for seven days. The realtime composer geometry test records its before/after rectangles and includes them in position failures. These diagnostics preserve the original assertions and help distinguish layout failures from lifecycle timing.

Repeated successful CI runs on the final revision are required to establish stability. Local repetitions alone do not meet that criterion.

The DX fixes passed the complete [Check run 39853635789](https://github.com/jdeurt/codex-pocket/actions/runs/39853635789) at commit `749f18c`, before the later authorized test cleanup. That run included all 196 default browser cases and all 75 realtime cases. The [suite audit](test-suite.md) records subsequent removals and simplifications; the cleanup revision requires its own CI validation.
