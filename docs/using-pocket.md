# Using Pocket

Send a task from the composer and follow the streamed response. Pocket shows questions and supported approval requests in the conversation. Agents keep running on the computer when your phone sleeps or the app closes; reopening Pocket restores the view.

## Named conversations

Open **Pockets** at the top left to create, name, rename, or switch conversations. Each entry shows its state and a short preview of its latest work. These main conversations are separate from delegated [Side Pockets](side-pockets.md).

Each Pocket has its own history, draft, reading position, pending questions, session model settings, schedules, and delegates. New Pockets inherit the host's working directory and native configuration. Switching views leaves background work running. Different browser tabs can use different Pockets; the URL identifies the selected conversation.

Deleting a Pocket removes its menu entry and closes its idle runtime. It retains saved Codex history and private delivery records on the computer. Resolve active work, pending questions, uncertain sends, active children, and schedules before deletion. Pocket asks for confirmation, switches to a surviving conversation when necessary, and prevents deletion of the last ready Pocket.

## Messages and activity

A pending send appears immediately and becomes confirmed when Codex acknowledges it. Failed or uncertain sends stay visible. If delivery is uncertain, inspect the conversation before retrying; the agent may already have received it.

When an uninterrupted turn finishes, progress messages collapse under **Show activity** while the final reply stays visible. Tap to expand them. Messages before a steering correction remain visible, and interrupted turns keep their updates.

The status row at the bottom of the transcript holds the thinking indicator, status text, and clickable agent count. It reserves the same space when those items disappear. Incoming delegate reports start as one-line previews; expand one to read the original report or open its Side Pocket.

## Files, images, and documents

Use the paperclip to send files or images, with or without text. See [file attachments](uploads.md) for limits, supported input, and draft recovery.

Assistant images appear as uncropped thumbnails. Tap one to open a larger preview; swipe down, use the close button, tap outside, or press Escape to dismiss it. Missing local images show an unavailable state.

Local Markdown links open a file viewer with a back button. Tables scroll within their own container. Other supported file types use the browser's viewer; unknown types offer a download. The computer can serve regular local files up to 64 MiB, with a 2 MiB limit for Markdown. Local images are limited to 25 MiB and 40 million pixels; the image endpoint does not support SVG. Remote images load directly in the browser.

Local links can expose files the host can read, so restrict access to Pocket to intended operators. The viewer sandboxes active content and does not fetch remote documents on the computer.

## Notifications

Tap **Enable notifications** and accept the browser's permission prompt. On iPhone or iPad, first add Pocket to the Home Screen and open it from that icon.

Pocket sends completion notifications for visible replies when the receiving device is backgrounded, locked, or closed. Silent turns do not trigger completion notifications. Keeping Pocket visible on a second device does not suppress the phone's notifications. Long replies may be shortened to fit the push payload, and the platform controls the displayed preview.

The Mac must be awake with Pocket running. Delivery also depends on the phone's notification settings and push service. Tapping a notification opens the owning Pocket. Verify delivery on the actual phone: complete a turn while Pocket is visible, then repeat while it is backgrounded or locked. Browser emulation cannot prove iOS notification delivery.

Keys, subscriptions, and delivery receipts are created automatically in `~/.pocket/data/push.json`. Preserve that file across updates; deleting it requires devices to enable notifications again. No separate notification service account is needed.

## Schedules and settings

Open **Pockets → Settings** using the gear in the top-left menu for global preferences and the **OpenAI API key** option. A key enables advanced functionality, including realtime. You can save, replace, or remove a saved key; its value is never displayed again. See [Pocket Settings](configuration.md#pocket-settings) for host storage and environment-key behavior.

Ask Pocket to [schedule a task](schedules.md) when you want it to act later. Tasks run on the Mac, so they depend on the host staying available.

You can ask Pocket to inspect or change its model and reasoning effort. Changes affect subsequent turns and future delegates that inherit defaults. Active turns and existing delegates keep their settings. See [session controls](session-controls.md) for the supported tools and accounting limits.
