# Pocket requests

This checklist tracks the operator's requests and accepted corrections. Update it with each shipped batch.

The working backlog is the [Pocket project in Linear](https://linear.app/juan-de-urtubey/project/pocket-3cb4a83787f8). Linear's plan limit prevented creating another team; the operator chose a project under Juan de Urtubey instead. Keep Linear statuses and this checklist in sync after verification and deployment.

## Linear issues

- [JUA-5](https://linear.app/juan-de-urtubey/issue/JUA-5/create-the-private-nextjs-pocket-repository): Create the private Next.js Pocket repository
- [JUA-6](https://linear.app/juan-de-urtubey/issue/JUA-6/use-the-engineering-plugin-lint-and-formatting-configuration): Use the engineering plugin lint and formatting configuration
- [JUA-7](https://linear.app/juan-de-urtubey/issue/JUA-7/connect-one-real-codex-chat-using-computer-side-environment): Connect one real Codex chat using computer-side environment configuration
- [JUA-8](https://linear.app/juan-de-urtubey/issue/JUA-8/build-the-minimal-mobile-chat-with-questions-and-approvals): Build the minimal mobile chat with questions and approvals
- [JUA-9](https://linear.app/juan-de-urtubey/issue/JUA-9/show-the-effective-model-and-reasoning-effort): Show the effective model and reasoning effort
- [JUA-10](https://linear.app/juan-de-urtubey/issue/JUA-10/configure-unrestricted-access-for-this-computers-pocket-chat): Configure unrestricted access for this computer's Pocket chat
- [JUA-11](https://linear.app/juan-de-urtubey/issue/JUA-11/serve-pocket-privately-through-tailscale-and-a-persistent-login): Serve Pocket privately through Tailscale and a persistent login service
- [JUA-12](https://linear.app/juan-de-urtubey/issue/JUA-12/document-agent-followable-setup-and-deployment-in-readme): Document agent-followable setup and deployment in README
- [JUA-13](https://linear.app/juan-de-urtubey/issue/JUA-13/align-the-mobile-composer-and-enlarge-the-send-button): Align the mobile composer and enlarge the send button
- [JUA-14](https://linear.app/juan-de-urtubey/issue/JUA-14/stream-live-updates-and-show-outgoing-messages-immediately): Stream live updates and show outgoing messages immediately
- [JUA-15](https://linear.app/juan-de-urtubey/issue/JUA-15/keep-failed-message-text-in-the-composer): Keep failed-message text in the composer
- [JUA-16](https://linear.app/juan-de-urtubey/issue/JUA-16/replace-thinking-text-with-a-small-muted-spinner): Replace Thinking text with a small muted spinner
- [JUA-17](https://linear.app/juan-de-urtubey/issue/JUA-17/smooth-first-time-history-scrolling-and-enlarge-jump-to-bottom): Smooth first-time history scrolling and enlarge jump-to-bottom
- [JUA-18](https://linear.app/juan-de-urtubey/issue/JUA-18/send-web-push-when-the-agent-finishes-its-turn): Send Web Push when the agent finishes its turn
- [JUA-19](https://linear.app/juan-de-urtubey/issue/JUA-19/fix-the-floating-notification-prompts-mobile-alignment): Fix the floating notification prompt's mobile alignment
- [JUA-20](https://linear.app/juan-de-urtubey/issue/JUA-20/use-pocket-consistently-throughout-interface-copy): Use Pocket consistently throughout interface copy
- [JUA-21](https://linear.app/juan-de-urtubey/issue/JUA-21/add-comprehensive-pino-diagnostics-and-rotating-private-log-files): Add comprehensive Pino diagnostics and rotating private log files
- [JUA-22](https://linear.app/juan-de-urtubey/issue/JUA-22/explain-connection-failures-and-retain-browser-diagnostics-across): Explain connection failures and retain browser diagnostics across disconnections
- [JUA-23](https://linear.app/juan-de-urtubey/issue/JUA-23/verify-turn-completion-notifications-on-the-installed-iphone-pwa): Verify turn-completion notifications on the installed iPhone PWA
- [JUA-24](https://linear.app/juan-de-urtubey/issue/JUA-24/validate-flexible-one-time-and-recurring-icalendar-schedules): Validate flexible one-time and recurring iCalendar schedules
- [JUA-25](https://linear.app/juan-de-urtubey/issue/JUA-25/persist-schedules-and-delivery-history-in-sqlite): Persist schedules and delivery history in SQLite
- [JUA-26](https://linear.app/juan-de-urtubey/issue/JUA-26/expose-schedule-crud-through-a-bundled-mcp-server): Expose schedule CRUD through a bundled MCP server
- [JUA-27](https://linear.app/juan-de-urtubey/issue/JUA-27/inject-due-scheduled-messages-into-the-real-codex-chat): Inject due scheduled messages into the real Codex chat
- [JUA-28](https://linear.app/juan-de-urtubey/issue/JUA-28/display-a-scheduled-task-marker-instead-of-its-injected-message-body): Display a scheduled-task marker instead of its injected message body
- [JUA-29](https://linear.app/juan-de-urtubey/issue/JUA-29/start-the-pocket-codex-process-automatically-and-append-scoped): Start the Pocket Codex process automatically and append scoped instructions
- [JUA-30](https://linear.app/juan-de-urtubey/issue/JUA-30/document-and-verify-scheduling-setup-tools-and-recovery): Document and verify scheduling setup, tools and recovery
- [JUA-31](https://linear.app/juan-de-urtubey/issue/JUA-31/display-image-output-and-local-image-references-in-chat): Display image output and local image references in chat
- [JUA-32](https://linear.app/juan-de-urtubey/issue/JUA-32/add-a-screen-fitted-image-preview-for-mobile): Add a screen-fitted image preview for mobile
- [JUA-33](https://linear.app/juan-de-urtubey/issue/JUA-33/maintain-request-tracking-and-deploy-each-completed-batch): Maintain request tracking and deploy each completed batch

## Shipped

- [x] Private repository under `~/Developer`, using Next.js, Tailwind and shadcn/ui.
- [x] Engineering plugin ESLint/Prettier configuration; ESLint runs with `--max-warnings=0`.
- [x] One real local Codex thread selected through environment configuration; steering or queueing configured on the computer.
- [x] Minimal phone chat, questions and approvals, with the page titled Pocket and the effective model/effort displayed.
- [x] This computer uses `gpt-6.1-sol`, `medium`, unrestricted Codex access and approval policy `never`.
- [x] Persistent login service, private Tailscale HTTPS access and agent setup instructions in the README.
- [x] Immediate muted outgoing messages, confirmation without duplicates and live updates to connected clients.
- [x] Keep failed-message text in the input field. Preserve this behavior in future changes.
- [x] Muted response-size activity spinner, larger send button with equal spacing, stable history layout and larger jump-to-bottom control.
- [x] Web Push for turn completion, with an upfront permission action. Actual Chrome push delivery reached the service worker with the page closed; the operator also confirmed delivery on the installed iPhone PWA.

## Notification and diagnostics batch (shipped)

- [x] Float the notification prompt over the chat with a subtle shadow, left-aligned text centered vertically, and touch-size Enable/dismiss buttons. Match the text's visible left inset to the X icon's visible right inset.
- [x] Use Pocket throughout interface copy, including “Message Pocket” and “Get notified when Pocket finishes.” Keep Codex names in technical configuration.
- [x] Pino diagnostics covering client failures, HTTP requests, SSE, message delivery, Codex RPC, push delivery and server lifecycle.
- [x] Rotate private JSONL logs at a configurable size, using each file's creation time as its ISO filename.
- [x] Retain client diagnostics through temporary disconnections and make restart/non-JSON errors understandable.
- [x] Verify failed-send text preservation with real Codex, log rotation/redaction with unit tests, and notification geometry in Chrome; push and restart the deployed server. Visible iPhone notification delivery was confirmed in JUA-23.

## Scheduling batch (shipped)

- [x] Validate iCalendar/RFC 5545 event text for one-time and recurring schedules, including timezone behavior.
- [x] Persist schedules and delivery state in SQLite. Schedules have a title and body; one-time schedules become inactive after firing.
- [x] Provide create, read, update and delete tools through a bundled MCP server available to Pocket's Codex process.
- [x] Inject due bodies as user input, using the configured steering/queueing behavior and durable message IDs.
- [x] Run scheduled tasks silently: hide their queued/confirmed triggers, titles and injected bodies while showing the agent's responses, questions and approvals (JUA-37 supersedes the marker UI from JUA-28).
- [x] Start Pocket's Codex process automatically and add scoped Pocket identity/scheduling instructions. Do not add delegation instructions.
- [x] Document setup, tools, recurrence, restart recovery and diagnosis for an agent.
- [x] Test with real Codex, require zero ESLint warnings, push the completed changes and restart the service.

## Images batch (shipped)

- [x] Display image output and local image references in the conversation.
- [x] Fit the complete image within the phone layout with rounded corners.
- [x] Open a screen-fitted full-size preview on tap, with an accessible touch-size close control.
- [x] Verify image loading and preview behavior on mobile, then push and restart the service. Real Codex image-reference tests pass; Chromium/WebKit geometry matches, and Safari's preview and close control were checked directly.

## Follow-up tickets created through Pocket

These later requests are tracked separately in Linear. Keep their existing owners and work in progress intact.

- [x] [JUA-34](https://linear.app/juan-de-urtubey/issue/JUA-34): Use reply text as the push notification body.
- [x] [JUA-35](https://linear.app/juan-de-urtubey/issue/JUA-35): Suppress completion notifications while Pocket is visible.
- [ ] [JUA-36](https://linear.app/juan-de-urtubey/issue/JUA-36): Collapse completed-turn activity under animated “Show activity” / “Hide activity” controls and match message spacing to Markdown.
- [x] [JUA-37](https://linear.app/juan-de-urtubey/issue/JUA-37): Run scheduled tasks silently without chat markers.
- [x] [JUA-38](https://linear.app/juan-de-urtubey/issue/JUA-38): Show concise, plural activity labels beside the spinner, using “Calling tools” for all tool calls.
- [x] [JUA-39](https://linear.app/juan-de-urtubey/issue/JUA-39): Restore fresh-open CSS/JavaScript and use the normal stop/build/start sequence. The operator accepted restarting the full service; keep the existing build layout.

## Notification content and foreground behavior

- [x] Send the final reply text, retaining full text within the Web Push transport limit and a fallback without final text.
- [x] Suppress a push only after a fresh foreground acknowledgement from the receiving subscription; retain delivery for background, locked, closed and stale connections.
- [x] Verify the updated reply preview, foreground suppression, background delivery, reconnects and tap-to-open on the installed iPhone PWA after deployment. The operator confirmed all iPhone checks pass.

## Delivery cadence

Push each finished batch and rebuild/restart the Next.js service so changes are visible on the phone. Wait for active turns to finish before restarting. Keep local configuration, credentials, database state and logs out of Git.
