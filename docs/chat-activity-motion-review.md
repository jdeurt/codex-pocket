# Activity content motion

Actual activity content uses `TraceCollapsibleContent` around the nested message virtualizer. The panel height expands/contracts with the shared 200ms `cubic-bezier(0.4, 0, 0.2, 1)` transition; the chevron is a separate element. Large activity lists keep individual message rows virtualized in the parent viewport. The outer list measures the interpolating panel, while body/footer share one normal-flow boundary.

This implementation was committed in `18414f4` (the integration branch's corresponding commit is `4c3a70f`). The older `7735a8f` flattened activity messages after a trigger and did not contain this panel. At inspection, agent-view `80dbe8b` and virtualization `977af21` had identical production activity/scroller/Trace sources, including the restored content panel. No production rewrite or rebase was needed for this follow-up.

## Rendered verification

`virtualization-activity-motion.spec.ts` opens and closes 4-message and 1,200-message activity groups through the actual Chat fixture, with Markdown, images and older history. It samples every animation frame rather than inferring motion from CSS declarations or chevron rotation. It asserts several distinct intermediate **panel heights in both directions**, actual nested message content present under the clipping panel, exact reader/control position, bounded mounted rows and all three fixed 16px outer boundaries. The fixture places the control 100px below the viewport top with enough following content to keep that reading offset legal. It asserts actual content is visible during both reveal and conceal, rather than activating a control below the viewport. Expansion/collapse also record videos under `.local/`; the final Chromium desktop small-panel and WebKit mobile large-panel contact sheets were inspected.

The final 1,200-message panel produced 10–11 intermediate expansion heights and 10–13 intermediate collapse heights across Chromium/WebKit desktop/mobile. Maximum mounted rows were 207–208, with 0px reader/control drift and 0px error at the fixed outer boundaries. The observed roughly 213,452px panel extent includes virtual estimates for unmounted messages; this is not a claim that all 1,200 message heights were measured or rendered.

The smaller panel produced 7 intermediate expansion heights and 10–11 intermediate collapse heights, with the same exact anchor/gap checks. Timing/easing are asserted against the shared token in addition to geometry.

The new flow also switches to reduced motion, reopens and closes the same measured panel, and verifies every nonzero sampled panel equals its unclipped content extent within 1px. Its reader/gap/budget checks cover both preferences. The final run passed **12/12** cases: these eight visible-content flows plus four existing live-preference flows across Chromium/WebKit desktop/mobile. Evidence: `.local/activity-content-visible-final.log`.

Before strengthening the fixture placement/reduced-motion geometry, the combined content, disclosure and bottom-motion run passed **24/24** cases on the same production code. The existing bottom-motion flow separately checks actual intermediate panel heights, independent scroll start after disclosure activation, a 200ms scroll clock, rapid toggles, no retained final bottom extent and gesture interruption. Image growth, local sends, streaming, viewport resizing and reduced-motion behavior remain covered by their existing whole flows. These are local development/browser-emulation results, not physical-device or production performance claims.

The unresolved unmounted long-return seek described in [the long-return review](chat-long-return-review.md) remains unchanged. Activity content interpolation and intentional bottom settling have independent lifecycles; preserving the content transition does not make that visible seek continuous or accepted.

Local preview/evidence paths:

- `.local/activity-content-{4,1200}-{chromium-desktop,chromium-mobile,webkit-desktop,webkit-mobile}.{json,png,webm}`
- `.local/activity-content-visible-final.log` (final 12/12), `.local/activity-content-final.log` (24/24 combined run)

Reproduce locally:

```sh
env CODEX_THREAD_ID='' npx playwright test --config playwright.virtualization.config.ts tests/browser/virtualization-activity-motion.spec.ts tests/browser/virtualization-disclosure.spec.ts tests/browser/virtualization-motion.spec.ts tests/browser/virtualization-reduced-motion.spec.ts
```

The fixture intercepts API/SSE/image requests and performs no real-session send. No CI, push or Pocket service restart is involved. This follow-up owns only the new whole-flow test and this note; it does not overlap Conversation, prompts, spacing CSS or the agent-view owner's active wiring.
