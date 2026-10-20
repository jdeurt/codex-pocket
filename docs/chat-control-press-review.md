# Preserve footer controls during scroll cancellation

The combined agent-view failure was a real scroll-controller issue. In its trace, the canvas was logically 3,062.3px high with a retained minimum of 4,441.67px at 8262.731ms, immediately before input. At 8270.118ms the logical height was unchanged but the minimum was zero and motion changed from settling to idle. Ordinary control pointerdown called `control()` → `cancel()` → `release()`, allowing the browser to clamp scrollTop before pointerup. The button moved away before activation.

A synthetic whole-flow replay reproduces the mechanism with stable short messages, the actual responsive approval Prompt, a footer dialog trigger and 320/390/1440 viewport resizes. The failed implementation had a 2,718.8px logical canvas with a 3,298.8px retained minimum. Pointerdown moved native offset 2243 → 1855 and button top 443.8 → 831.8: **388px before pointerup**. The strict 1px hitbox assertion fails before the fix. Evidence: `.local/control-press-before.log` and `.local/control-press-before-chromium-desktop.json`.

Natural timed repeats can miss the short settling window. The replay uses the documented [Playwright clock](https://playwright.dev/docs/clock) to hold that real pending correction between resize and input, then advances animation frames while the mouse remains down. It requires more than 100px of actual retained extent, so it cannot pass by accidentally testing an already-settled canvas. It uses real mouse/touch input, without a forced click, retry fallback or wider hitbox tolerance.

## Controller behavior

`TranscriptControlPress` retains the current extent through native pointerup/click activation. Cancellation still immediately stops the animation and library end command. The controller does not resume intentional motion while the control is pressed. Global pointer/touch completion, cancellation and window-blur listeners clean up after activation; unmount aborts the listeners and pending frame. Window blur is observed without capture, so moving focus from the composer to a control cannot prematurely complete the press. Slight pointer movement preserves the same retention until activation/cancellation finishes.

For an ordinary non-overlay action, an offset that becomes illegal when the old extent is removed settles independently after activation with the existing shared 200ms easing. A legal reading offset stays fixed. A wheel gesture that cancels the click owns scrolling and is not pulled back.

An overlay can capture a press that interrupted a resize correction **beyond the new logical end**. Releasing that extent on dialog close would merely postpone the same clamp. The controller therefore preserves that interrupted snapshot's existing extent through suspension and return, with following disabled, until the user scrolls or explicitly chooses latest. This can preserve the tail space that was already visible at interruption; it does not insert a row or a gap before status. Explicit latest releases it through normal settling and ends with zero retained minimum/bottom gap. Ordinary valid history anchors do not need this retained snapshot extent.

The unchanged scroll timing/retarget arithmetic was extracted into `TranscriptScrollAnimation` to keep the controller within the repository's 350-line limit. It remains the same clock driven by the single motion owner; it adds no second bottom-follow policy or native smooth-scroll source. The helper guards cancelled frames before and after its write callback. Shared activity height animation, projection, row/footer spacing and Conversation JSX are untouched.

## Verification boundary

`virtualization-control-press.spec.ts` checks dialog activation and return, ordinary approval-button activation against a rejecting local fixture callback, wheel cancellation and native touch activation in mobile projects. Every press retains the same button coordinates within the unchanged 1px assertion. Overlay return samples every frame at the saved offset; explicit latest must remove the held extent and arrive with less than 2px end gap. Cancelled gestures must retain their chosen legal position and open no dialog.

Final focused press verification passed **14/14**, with two desktop-only touch cases intentionally skipped, across Chromium/WebKit desktop/mobile in 33.1 seconds. It includes an initially focused composer/draft and 1px pointer movement during the press. Dialog/touch press drift was 0px; approval-control drift remained below 0.5px, within the unchanged 1px assertion. All saved return offsets and cancellation positions passed; explicit latest and ordinary activation ended with zero retained minimum and less than 2px end gap. Evidence: `.local/control-press-focused-composer-final.log` and matching per-mode JSON/pressed/complete PNG files. The final Chromium desktop pressed and complete screenshots were inspected locally.

The broader scoped run passed 40 of 42 active cases, with two desktop touch skips. Two existing test entry steps were diagnosed: sampling CSS animation after an arbitrary two frames could precede transition start, and separately dispatching a synthetic wheel and applying its native offset allowed the two-frame end-rearm check to run between them. The fixtures now observe actual `transitionrun` and apply wheel/scroll mutation in one browser task. All original offset/gap/timing limits remain unchanged. The following focused motion/press/live-preference run passed **30/30**, plus the same two skips, in 1.7 minutes. The final window-blur focus refinement was then checked by the 14-case run above; the full 42-case matrix was not rerun after that focus-only refinement. Logs: `.local/control-press-final.log` and `.local/control-press-final-focused.log`.

The test-only dialog fixture now renders requests through the existing Prompt. Its answer callback rejects locally; it performs no real answer/send or API mutation. Fixture servers explicitly clear CODEX_THREAD_ID. Original viewer artifacts/source were read only. No parent/main/Conversation edits, rebase, CI, push or actual Pocket service restart is involved.

Artifacts remain local: `.local/control-press-*-{chromium-desktop,chromium-mobile,webkit-desktop,webkit-mobile}.json`, screenshots and the corresponding before/focused/regression logs. The separate unmounted long-return seek remains unaccepted as documented in [its review](chat-long-return-review.md).

Reproduce the focused flows locally:

```sh
env CODEX_THREAD_ID='' npx playwright test --config playwright.virtualization.config.ts tests/browser/virtualization-control-press.spec.ts tests/browser/virtualization-motion.spec.ts tests/browser/virtualization-reduced-motion.spec.ts
```

The follow-up is based on `ddbae0a`; lineage was not rebased. Product overlap is only `src/lib/transcript-scroll-motion.ts` and the new internal `transcript-control-press.ts` / `transcript-scroll-animation.ts`. Remaining changes are whole-flow fixtures/tests and this note. Viewer-owned Conversation/suspended wiring remains untouched.
