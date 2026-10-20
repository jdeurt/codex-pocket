# Named Pockets

Open **Pockets** at the top left to create, name, rename, or switch between independent main conversations. Each entry shows its current state and a short excerpt of its latest visible work. These are separate from delegated Side Pockets.

The configured `CODEX_THREAD_ID` is imported as the original Pocket. New Pockets inherit the host's working directory, native configuration, and origin policy. Each has its own native bridge, delivery receipts, attachments, pending questions, settings, schedules, and delegated workers. Switching views does not stop background work.

The selected Pocket is explicit in the URL. Different tabs can use different Pockets. Drafts persist by Pocket; each tab saves its reading position using TanStack's documented `takeSnapshot`, `initialMeasurementsCache`, and `initialOffset` interfaces. File links and notification links retain the owning Pocket.

Deletion requires confirmation. It removes the menu entry and closes an idle runtime; saved Codex history and private receipts remain on the computer. Active turns, pending prompts, unresolved sends, active children, and schedules must be resolved first. Deleting the current Pocket opens a surviving one. The last ready Pocket cannot be deleted. The home bookmark redirects to a survivor if the original Pocket was deleted.

Names and native identities live in the private `pockets.sqlite` catalog. Creation reserves a durable caller ID before calling Codex. Repeated requests cannot create duplicate native threads. Interrupted creation is marked incomplete at host startup, without retrying uncertain native work. Naming a new native thread makes its empty history resumable; this was verified on the installed Codex app-server using a second process, without a model turn.

For desktop answers in another main Pocket, set `POCKET_ID` to its URL identity before running `npm run desktop -- requests` or `respond`. Replies include the native parent identity so equal request IDs in different app-server processes cannot cross conversations.

# Composer status area

The status row belongs to the composer, outside the transcript's scroll container. It always reserves 44px and has a 10px gap above the input. Notifications, errors, and attachments appear above it. The indicator, one-line status text, and agents hint share a vertical center; the agents button has a 44px touch target without negative vertical margins. Empty, thinking-only, agents-only, and combined states use the same geometry.

# Verification

`tests/browser/pockets.spec.ts` drives the real app and production APIs through offline Codex simulator processes. It exercises independent tabs, names, previews, drafts, rename, deletion, idempotent creation, and invalid selections. Playwright measures narrow-menu overflow, header centering, and touch targets.

`tests/browser/virtualization-tail.spec.ts` measures the fixed row, input gap, and text alignment across states and both spinner types. `virtualization-pocket-scroll.spec.ts` verifies native bookmark restoration. These run in Chromium and WebKit phone and desktop profiles.

`tests/named-pockets-flow.test.ts` uses two fresh host processes against one private fixture directory. It proves separate histories, receipt namespaces, upload ownership, restart recovery without replay, and refusal to delete active or final Pockets. The simulator stores sessions independently in SQLite so concurrent app-server processes cannot overwrite each other's state.
