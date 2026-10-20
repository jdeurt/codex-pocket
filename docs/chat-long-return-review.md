# Long-return motion: narrow fix, broader UX pending

A verified unnecessary snap is fixed: when the whole return path is already mounted, it now animates its entire distance for 200ms with `cubic-bezier(0.4, 0, 0.2, 1)`. Previously even a fully mounted 120-row history instantly traversed about 98.2% of the distance before animating the tail.

The remaining candidate does **not** provide continuous full-distance animation through an unmounted history range. A correction farther than two viewport heights whose path is not fully mounted still seeks near the end, then animates the final half viewport. That seek is visible and remains unaccepted pending parent UX review.

The eligibility check uses [TanStack's current virtual items](https://tanstack.com/virtual/latest/docs/api/virtualizer#getvirtualitems) and the mounted count of nested activity lists. It adds no rows, scroll writer or message-content predicate. Ordinary corrections within two viewport heights, and longer corrections through fully mounted content, use the full-distance shared animation. History/image anchor corrections remain immediate; gestures and suspension still cancel intentional motion.

This is governed by the mounted range, not only transcript length: a chat just over the 150-row window can also take this path when reading older history. The remaining threshold can also affect very large disclosure or layout changes with partially virtualized activity content. It must not be described as an exception for only the Jump button.

## Local comparison

Synthetic histories contain variable-height Markdown/code messages and images, with a 150-row history buffer and 50-row forward buffer. These are local Next development measurements with recording enabled, not production or physical-device performance claims.

| Candidate                                                 | Initial jump | Uncovered frames                        | Longest later frame interval                   | Result                                             |
| --------------------------------------------------------- | ------------ | --------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Before: fully mounted 120 rows, about 20,700px            | About 98.2%  | 0 in Chromium desktop/WebKit mobile     | 34ms / 30ms                                    | Unnecessary visible discontinuity                  |
| Fixed: same fully mounted path, all four browser projects | 0px          | 0 in all four                           | 35–47ms; 1–3 intervals over 34ms per recording | Full-distance animation, 11 intermediate positions |
| Retained: 1,200-row unmounted path, about 215,000px       | About 99.8%  | 0 in all four                           | 23ms / 37ms in Chromium desktop/WebKit mobile  | Covered, but visibly discontinuous and unaccepted  |
| Experimental full-distance 200ms through unmounted path   | 0px          | 2 / 3 in Chromium desktop/WebKit mobile | 151ms / 167ms                                  | Blank painted regions and stalls                   |
| Experimental full-distance 1,000ms through unmounted path | 0px          | 5 / 5 in Chromium desktop/WebKit mobile | 133ms / 244ms                                  | More positions, still blank regions and stalls     |

The videos/contact sheets were inspected. Both unmounted-path continuous experiments visibly expose missing content while the range catches up. A separate 1,000ms duration was tried only for the explicit-return comparison and discarded before broader validation. Neither experimental implementation was retained.

The fixed mounted path retains 120 DOM rows, lands within 0–1px of the end and reaches its first recorded frame in 1–8ms. The retained unmounted-path candidate uses 156–157 DOM rows and lands with 0px final gap. Its first recorded frame arrives 134–224ms after the command; later frame-interval figures exclude that initial delay and must not be read as uninterrupted 60fps motion.

These limited experiments do not establish that continuous virtualization is impossible. They establish that removing the seek or only extending duration is insufficient for an unmounted range in the current renderer. No broad rendering/prefetch/pacing change was introduced under this narrow review.

## Preview and reproduction

Local artifacts are intentionally outside the committed tree. Videos include startup and the deliberate move to older history; review the return after Message 0 is visible, rather than treating initial loading skeletons as part of the return.

- Fixed mounted path: `.local/long-return-final-120-chromium-desktop.webm` and `long-return-final-120-webkit-mobile.webm`.
- Remaining visible seek: `.local/long-return-final-1200-chromium-desktop.webm` and `long-return-final-1200-webkit-mobile.webm`.
- Failed continuous alternatives: `.local/long-return-continuous-chromium-desktop.webm`, `long-return-continuous-webkit-mobile.webm`, and `long-return-continuous-1000-webkit-mobile.webm`.
- Matching `.json` frame traces and `*-contact.png` contact sheets under `.local/`.
- `.local/long-return-mounted-path.log`, `.local/long-return-continuous.log`, and `.local/long-return-continuous-1000.log`.

Reproduce both 120-row and 1,200-row profiles with:

```sh
env CODEX_THREAD_ID='' POCKET_RETURN_PREVIEW=final npx playwright test --config playwright.virtualization.config.ts tests/browser/virtualization-return.spec.ts
```

The 120-row profile strictly asserts no immediate jump. The 1,200-row profile exports its jump explicitly and verifies coverage, bounded rows and final arrival; passing those assertions does not approve its continuity. No existing strict offset/anchor assertion was relaxed.

Two narrow changes were retained in production: seek eligibility and an immediate actual-offset read-back after an intentional seek. A strict WebKit regression exposed one blank frame while the native offset had changed but the rendered window still reflected the old position. The read-back uses the documented [observeElementOffset extension](https://tanstack.com/virtual/latest/docs/api/virtualizer#observeelementoffset), keeps the standard native observers, and updates outer/nested ranges before paint. It reports actual native scrollTop, does not mutate private caches or add another follow loop, and leaves normal history/gesture observation unchanged. The affected streaming/send/return flow passed three focused WebKit repeats after this correction. Existing strict assertions were preserved. Suspended API, shared projection, activity height/chevron animation, hit targets, spacing, draft preservation and ordinary correction timing remain intact. Returns beyond the mounted path remain unresolved pending parent review of the concrete preview or further focused implementation work. No CI, push or actual Pocket restart was performed.

## Regression boundary

The broader local run passed 43 of 44 cases and exposed a remaining hidden-parent measurement race. CSS display:none resets native offset to zero; allowing that value through changed the hidden virtual window and introduced unrelated estimated rows. The completed controller now freezes the _observed_ offset at the saved snapshot while suspended/restoring, retains cached sizes until actual visibility, skips hidden nested-margin reads and restores native position before reveal paint. It does not write native position while hidden or reset measurement caches.

The strengthened fixture delays visibility by two closing frames and checks every first-visible-frame offset without widening its 1px limit. Four repeated WebKit mobile hidden checks passed, followed by 12/12 final covered/hidden/dialog checks across Chromium/WebKit desktop/mobile, including footer removal, composer focus and interrupted restoration. No existing strict assertion was relaxed. This is focused validation of the final suspension refinement, not a claim that the final entire 44-case matrix was rerun. Evidence: `.local/long-return-hidden-window.log`, `.local/long-return-final-suspension.log`, and `.local/long-return-verified-regression.log`.

The run also prompted a stricter end-pin check against both measured and actual native extent, and cancellation during pointer dragging. The disclosure fixture applies its gesture and offset mutation in one browser task rather than separate protocol calls; its gap and anchor assertions are unchanged. Six focused disclosure repeats passed. The production change remains within the shared scroller and its supported observer adapter; Conversation/footer JSX and shared content projection are untouched.
