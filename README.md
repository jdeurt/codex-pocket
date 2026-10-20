# Pocket

A small phone interface for Codex conversations running on your computer. Messages stream live. Tool activity appears as a small muted spinner. Sends appear immediately in a muted bubble and become solid when Codex acknowledges them. Codex can ask questions and request approvals in the conversation.

Built with Next.js, Tailwind CSS and shadcn/ui. Native permissions and configuration belong to the computer; the phone manages named conversations and messages.

Open the top-left **Pockets** menu to create named conversations, see their current work, and switch between them. Each Pocket keeps its own history, draft, reading position, and background work. See [named Pockets and deletion behavior](docs/NAMED_POCKETS.md).

## Install on a Mac

Run this from any directory with authenticated Git and GitHub CLI access to this private repository:

```sh
gh api repos/jdeurt/codex-pocket/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | bash
```

Or run `./install.sh` from an existing checkout. Both entry points fetch the latest `main` into `~/.pocket/source`, download and checksum a private Node.js 24 runtime, and build an isolated release. The installer finds Codex locally or installs it privately, guides first-time sign-in, and asks for a working directory and optional phone HTTPS address. First setup creates a saved Pocket conversation and runs a short welcome turn; updates reuse it.

Everything installed belongs under `~/.pocket`: configuration in `~/.pocket/.env.local`, conversation data in `data/`, logs in `logs/`, the default working folder in `workspace/`, source in `source/`, and built versions in `releases/`. `current` selects the accepted release. Node runtimes live in `runtimes/`; an optional private Codex installation lives in `codex/`. Setup starts fresh and does not import another checkout's settings or data.

The installer adds `~/.pocket/bin` to zsh or bash PATH. Open a new terminal, or run `export PATH="$HOME/.pocket/bin:$PATH"` in the current one. Other shells can add that directory to their executable search path.

For unattended installation, requiring an existing Codex login:

```sh
gh api repos/jdeurt/codex-pocket/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | bash -s -- --yes
```

Dependency installation, setup, checks and production compilation finish before Pocket is stopped. A failed build discards only the candidate. A failed launch restores the previous configuration, selected release and login service. Successful releases are retained for recovery; persistent data is shared and never replaced by a build.

Optional setup inputs:

| Variable            | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `POCKET_CWD`        | Working folder; defaults to the saved folder or `~/.pocket/workspace`           |
| `POCKET_ORIGIN`     | Optional HTTPS origin for phone access, such as `https://pocket.example.com`    |
| `POCKET_THREAD_ID`  | Existing saved chat to select; an explicit empty value creates a new chat       |
| `CODEX_BINARY`      | Explicit Codex executable, otherwise detected automatically                     |
| `CODEX_SERVER_ARGS` | Process settings, otherwise preserved from `.env.local` or inherited from Codex |

To configure an unrestricted process explicitly, set `CODEX_SERVER_ARGS` before running the installer:

```sh
export CODEX_SERVER_ARGS='["app-server","--listen","stdio://","-c","sandbox_mode=\"danger-full-access\"","-c","approval_policy=\"never\""]'
./install.sh
```

Configure model and reasoning effort through Codex settings or additional process arguments. The installer does not change global Codex configuration. It writes private environment settings atomically with owner-only permissions. A first-time setup creates a real saved chat and runs a short welcome turn; updates keep the existing chat.

## Connect a phone

Pocket listens on `http://127.0.0.1:3000`. Use an HTTPS reverse proxy or tunnel of your choice to reach that address from your phone. Networking is configured separately from Pocket. Preserve the external Host/Origin headers and allow long-lived server-sent event connections without response buffering.

Set `POCKET_ORIGIN=https://pocket.example.com` when running the installer, or add that origin to `CODEX_ALLOWED_ORIGINS` in `~/.pocket/.env.local` and restart. Origins have no path, query or fragment. Local setup works without a phone address. Open the HTTPS address on the phone and add Pocket to the Home Screen for PWA notifications.

Access to that address grants control of the configured Codex conversations. Use your proxy or network’s access controls for the intended operators; Pocket has no separate account system. The Mac must be awake and its user logged in.

## Operate and update

Run these commands from any directory:

```sh
pocket update   # Fetch latest main, build, validate, then switch releases
pocket start    # Start the saved login service
pocket stop     # Stop it without deleting data or configuration
pocket restart # Restart the saved release
```

Wait for active Codex turns before an update or restart unless interruption is intended. A build failure leaves the existing server and its assets intact. The installer locks concurrent updates and refuses to overwrite edits in the managed source checkout. It never rewrites remote history. If an installer is forcibly terminated, confirm it has exited before removing a stale `~/.pocket/bootstrap.lock` or `~/.pocket/install.lock` directory and retrying.

An open Pocket checks for new builds every 15 seconds and when it reconnects or returns to the foreground. It refreshes automatically after a successful version check, preserving saved composer text and attachments. Refresh waits for active sends, uploads, unsaved browser storage, and Pocket-name editing; an uncertain send stays visible for reconciliation. A same-build restart reconnects without reloading. Clients from before automatic updates need one final refresh to acquire this behavior.

The login service is `gui/$(id -u)/dev.pocket.web`, installed at `~/Library/LaunchAgents/dev.pocket.web.plist`. It starts at login, restarts after a crash, and binds only to loopback. After editing `~/.pocket/.env.local`, use `pocket restart`. Inspect service state with `launchctl print "gui/$(id -u)/dev.pocket.web"`. Startup logs are `~/.pocket/logs/pocket.log` and `pocket.err.log`. Existing proxy and tunnel routes are outside the installer.

For development, use Node.js 24 in a separate checkout, then run `npm ci` and `npm run dev`. Manual `npm run setup` writes that checkout's `.env.local`; set `CODEX_POCKET_STATE_DIR` to a disposable directory to keep development separate from the installed data. Do not edit or build inside an accepted release directory.

## Notifications

On the first visit, Pocket offers an **Enable notifications** button. Tap it to open the browser's permission prompt. On iPhone or iPad, first add Pocket to the Home Screen and open it from that icon; a regular Safari tab cannot request Web Push permission.

Pocket sends an encrypted Web Push notification when Codex ends a turn while the receiving device is backgrounded, locked or closed. The title is **Pocket** and the body contains the final reply. The platform controls the displayed preview and truncation; Pocket preserves the full text when it fits the transport limit. Longer replies are shortened only to keep the encrypted payload within 4096 bytes, accounting for JSON, UTF-8 and encryption overhead. If there is no final reply, Pocket uses a completion or stopped fallback. Tapping the notification opens or focuses Pocket. The Mac must be awake with Pocket running. Delivery also depends on the device's notification settings and push service.

Pocket suppresses a completion push only after that subscription's visible page answers a fresh foreground probe. Visibility on another device cannot mute this device. Hidden pages close their presence connection, reconnects establish a new connection, and unanswered probes expire after 1.5 seconds so a stale stream cannot keep a suspended phone muted. Suppression happens before sending the push: the service worker always displays received pushes, as [WebKit requires](https://webkit.org/blog/12945/meet-web-push/).

VAPID keys, device subscriptions and notification receipts are generated automatically and saved privately in `~/.pocket/data/push.json`. Keep this file across restarts and deployments. Deleting it invalidates existing device subscriptions, which must then be enabled again. Expired subscriptions are removed when their push service rejects them. No API key or paid notification service is needed.

After setup or an update, open the installed iPhone PWA and let it reconnect and load the current client. Verify that a reply produces no notification while Pocket is visible, then background or lock the phone before a reply completes and confirm its text appears in a notification. Tap it to check that Pocket opens, and repeat after reconnecting. Keep Pocket open on a second device while the phone is backgrounded to verify device isolation. This visible delivery check must happen on the actual phone; a desktop browser emulator does not verify iOS notification delivery.

## Conversation activity

Progress messages stream normally while a turn runs. When an uninterrupted turn finishes, its progress messages collapse under **Show activity**; the final reply stays visible. Tap to expand or collapse the activity, or use the keyboard. The panel and chevron animate unless reduced motion is enabled. The control uses the same muted color and opacity as the live activity indicator. When the user steers a running turn, all earlier updates remain visible before that user message. Each later steering message preserves the updates before it too; interrupted turns keep their visible messages. History reconstruction retains these boundaries, while ordinary completed activity starts collapsed. Split assistant messages use the same spacing as Markdown paragraphs. Images and phone messages remain visible.

Markdown tables size columns to their widest value, wrapping long content at 24rem. Wider tables scroll horizontally inside their own focusable region, with touch and keyboard support. The chat itself keeps its normal width, and Markdown column alignment is preserved.

## Restart recovery

When Codex starts with existing conversation history, Pocket sends one hidden restart-recovery prompt through the normal durable outbox. It asks the agent to continue unfinished work and inspect any expected subagents or delegated jobs before resuming them. The injected prompt stays hidden by its internal message identity, including queued sends and reloaded history; the agent's activity, replies, questions and notifications behave normally. Empty chats do not receive it, and browser/SSE reconnects do not trigger another prompt. Pending recovery sends are reused; uncertain ones remain in the outbox for inspection. Look for `recovery.queued` and its message ID in the RPC/delivery logs.

Pocket adds session guidance through Codex’s developer instructions while preserving the built-in system prompt. The current Codex CLI can retain earlier developer instructions when resuming an existing chat. Pocket preserves that saved history. If a clean instruction context is needed, explicitly create a new chat with `POCKET_THREAD_ID='' pocket update`; this selects a new conversation.

## Scheduled tasks

Pocket starts its owned Codex process when the service starts, even without an open phone client. It appends Pocket identity, scheduling and delegation instructions to the configured developer instructions, and adds a bundled `pocket` MCP server to the main process. The bundled scheduling tools are preapproved so future tasks can run unattended. It does not edit the global Codex configuration.

Ask Pocket in chat to schedule something, or use its MCP tools from the Codex session: `schedule_create`, `schedule_list`, `schedule_get`, `schedule_update` and `schedule_delete`. A schedule has a `title`, a `body` containing the instructions to send later, a `calendar` string and an optional `active` boolean. Update accepts `changes` and an optional `expectedRevision`; read the latest revision before editing.

Calendar text is iCalendar/RFC 5545: a single VEVENT or VCALENDAR containing one VEVENT, or just DTSTART and recurrence properties. Use seconds and either UTC `Z` or an IANA `TZID`. Floating times, all-day dates, custom timezones, nested alarms, multiple events and unsupported properties are rejected. Recurrence evaluation has a two-second limit.

One-time example (replace the date with a future instant):

```text
DTSTART:20261020T160000Z
```

Weekday example in the computer operator's chosen timezone:

```text
DTSTART;TZID=America/Los_Angeles:20261020T090000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
```

RRULE supports recurrence fields such as COUNT or UTC UNTIL, and RDATE/EXDATE add or exclude occurrences. Ask the agent to read the computer's current date and confirm the intended timezone before creating an event. An active schedule must have a future occurrence. Enable/disable uses `active: true` or `false`.

When due, Pocket silently injects the body into the real Codex chat using the same steering/queueing mode as phone messages. The trigger, title and injected user-message body stay hidden from the phone, including queued tasks and reloaded history. The agent's responses, questions and approval requests appear normally, and its responses can mention task details. A one-time event becomes inactive after it fires.

Schedules and immutable delivery history live in owner-private `~/.pocket/data/schedules.sqlite` with SQLite WAL. Keep the database and its `-wal`/`-shm` files across updates; use SQLite backup facilities for a consistent live backup. Deleting a task cancels future occurrences and pending deliveries, while retaining delivery history so previous triggers remain hidden. Messages already accepted or in flight cannot be recalled.

Tasks run only while this Mac is awake and Pocket is running. After downtime, Pocket sends one overdue occurrence per task and advances a repeated task to its next future occurrence; it does not flood the chat with every missed repetition. After a restart, scheduled deliveries reuse each run's durable message ID. An uncertain Codex acknowledgment is retained for inspection rather than automatically replayed. Diagnose `schedule.*` events alongside the matching outbox receipt before retrying anything.

## Side Pockets

Main Pocket runs Codex. It can delegate work to independent **Side Pockets** using either Codex or Claude Code. Each child has a title, ID, working folder and saved harness session. Ask Pocket to delegate a task and name the desired harness when it matters.

Claude delegation requires Claude Code installed and signed in on this Mac. Pocket discovers the executable on PATH or in standard install locations; set `POCKET_CLAUDE_BINARY` in `~/.pocket/.env.local` for another location. The adapter uses the official Claude Agent SDK with the local executable and authentication. `POCKET_CLAUDE_MODEL` sets its default model; a creation-time model overrides that default. Codex children inherit the parent's model by default. Children inherit reasoning effort; Claude maps Codex `minimal` to `low`.

Access follows the main Codex parent's effective policy. A parent with `danger-full-access` and approval policy `never` maps to Claude `bypassPermissions`, permission skipping enabled and sandbox disabled. Claude rejects other parent permission profiles because their filesystem/network/approval rules cannot be mapped exactly. Codex children use the native sandbox and approval settings. Pocket reports these capabilities to the parent. Native harness tools, skills and subagents remain available.

The parent has these tools:

| Tool                       | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `side_pocket_capabilities` | Check harness availability and supported behavior                              |
| `side_pocket_sessions`     | Discover saved Codex sessions or list sessions loaded by an owning server      |
| `side_pocket_adopt`        | Track an existing Codex session without replaying its original work            |
| `side_pocket_create`       | Choose a harness, title and body; optionally choose a folder, model and effort |
| `side_pocket_list`         | Look up titles, IDs, saved sessions and lifecycle states                       |
| `side_pocket_get`          | Inspect a child's messages, delivery results and pending harness requests      |
| `side_pocket_send`         | Steer current work; explicitly queue a distinct later task                     |
| `side_pocket_cancel`       | Cancel selected unsent queued assignments with an audit reason                 |
| `side_pocket_answer`       | Answer a harness request using its child ID and request ID                     |
| `side_pocket_close`        | Stop the actual harness process and cancel queued work                         |
| `side_pocket_resume`       | Reopen the same saved child identity for later messages                        |

Create and send require an `idempotencyKey`. Retrying the same operation with the same key returns its existing identity/delivery; different content with that key is rejected. `side_pocket_send` defaults to `mode: "steer"` for current-task corrections and answers. Active Codex steering uses its existing slot and checks the expected turn ID; acceptance does not prove the model consumed the message. Active Claude steering returns an explicit unsupported outcome. Use `mode: "queue"` only for an explicitly distinct later task. `supersedes` and `side_pocket_cancel` cancel selected unsent assignments while preserving unrelated work and uncertain deliveries. Closing waits for host confirmation of process exit and retains conversation history. Resume makes the child ready for the next send; the harness process starts when work arrives and exits after its turn.

Each child's Pocket tool is `message_parent`, which accepts `{ "message": "..." }` and routes it to the recorded parent. Identical messages within one child turn reuse the same delivery. Children use it for questions, progress and completion reports. A question ends the child's current turn; the parent answers with `side_pocket_send` in the same saved session. Pocket scheduling and Side Pocket management tools belong to the main session. The host also handles native Codex questions/approvals and sends a completion fallback when a child has not messaged its parent.

Opening a Side Pocket gives its history reads priority over background previews. Previously read conversations appear from the bounded cache while native history refreshes. Cold conversations and pending previews use skeleton placeholders; errors and empty histories retain their explanatory messages.

Delegate reports reach the parent through its durable outbox, waking it when idle. The phone displays incoming reports as collapsed, single-line previews. Expand a report to read its original text, including questions, choices and blockers, then choose **Open Side Pocket** to view its sending agent's read-only chat. The parent draft and reading position are retained. Original parent delivery remains unchanged; reports are not paraphrased. Children default to the parent's folder. Coordinate file ownership or provide separate worktrees for concurrent changes. Pocket runs up to eight child turns concurrently across both harnesses; main Pocket is excluded. Eligible assignments run in queue order across children, with each child's follow-ups kept sequential.

Delegation dispatch and delivery wake on local filesystem notifications shared by the host and MCP processes. Enqueue, child mail, harness requests/answers, cancellation, closure and completion publish a coalesced hint after the SQLite transaction commits. Startup scans persisted work, and child process exit wakes dispatch as soon as a slot is free. The host reconciles every 30 seconds to cover lost filesystem notifications, a writer exiting between commit and notification, and pending parent delivery retries. SQLite claims and stable message IDs remain authoritative; the notification file contains no work payload. A slow parent delivery or child shutdown does not block other dispatch or answer handling. The close tool waits for closure notifications with a final state check at its 15-second deadline.

State and delivery history live in owner-private `~/.pocket/data/delegations.sqlite` with SQLite WAL. Keep it and its `-wal`/`-shm` files across deployments, along with the harnesses' native saved-session storage. If Pocket stops during a child send, that outcome becomes unknown and the parent receives a recovery report. Inspect the saved history before resuming and sending continuation instructions; uncertain work is not replayed automatically. Pending parent reports retain stable delivery IDs across restarts. Logs use `side_pocket.*` events alongside normal RPC and outbox diagnostics.

### Hook an existing Codex session

Ask Pocket to find your saved Codex sessions, then adopt the selected thread ID under a name. It appears in the existing Agents view with its original transcript. Adoption does not send an assignment; subsequent messages resume that same session with delegate tracking and normal completion reports. Stop using a saved session in its other window before handing it to Pocket. A thread ID cannot prove that another process has stopped using it.

For a session actively running elsewhere, provide the **absolute Unix socket path of its owning Codex app-server** as `socketPath` to `side_pocket_adopt`. The server must already have the thread loaded. Pocket subscribes to the original session, watches the current turn, and reports its result without starting another turn. This uses the [official app-server Unix WebSocket transport and thread subscription API](https://learn.chatgpt.com/docs/app-server). An app-server can expose this transport with `--listen unix:///absolute/path/codex.sock`; starting a new server does not expose a session already running in a different server or an ordinary standalone CLI process.

Live attachment keeps the owner's model, permissions, tools and approval handling. It does not inject `message_parent` into that external session; Pocket sends the observed completion report itself. Corrections use native conditional steering while that turn is tracked. Later assignments go through the same owner. Closing a live attachment cancels Pocket's queued work and disconnects its socket without interrupting or archiving the original session. An unavailable owner causes an explicit failure, never a saved-copy fallback.

After a disconnect, or to observe another turn started in the original window, use `side_pocket_resume`. Pocket checks the same owner and tracks its current turn without replaying uncertain input. Sessions already tracked by another Side Pocket, and main Pocket sessions, cannot be adopted again. Adoption retries use the same `idempotencyKey`.

## Images

Pocket displays generated images, image-view output, MCP/tool image content and image attachments already in the conversation. Assistant Markdown images can reference absolute computer paths, `file:` URLs, paths relative to `CODEX_CWD`, HTTPS URLs or inline raster images.

Chat thumbnails keep the image’s proportions without cropping, with rounded corners and no decorative frame. Previews align with message text; image attachments and Markdown images in the same paragraph share a row when they fit and wrap with consistent spacing. Tap an image for the existing screen-fitted preview. Swipe down to dismiss it, use the touch-size close control, tap outside it or press Escape. The viewer follows the swipe and slides down on dismissal; reduced motion disables its transitions.

Local and tool images go through Pocket's guarded image endpoint. It validates raster content, limits input to 25 MiB and 40 million pixels, and serves WebP thumbnails/previews. SVG is unsupported by that endpoint. Remote HTTP(S) images load directly in the browser. Tool image bytes are omitted from live snapshots and summarized by size in diagnostics. Removed or inaccessible local files show an unavailable state.

## Local documents and session controls

Local Markdown links open a full-screen file viewer with a basename header, a back button and deliberate edge swipe-back. The parent conversation stays mounted. Markdown uses the chat renderer, including tables, copy actions and file-relative links/images. Other supported types use the browser's native frame; unknown types offer a download. File reads require the existing host/origin boundary, accept regular local files up to 64 MiB (Markdown up to 2 MiB), and sandbox active content. They do not fetch remote URLs on the computer.

Main Pocket has two typed tools: `pocket_session_inspect` reports its model, effort, active turn and native token accounting; `pocket_session_settings` accepts only `model` and/or `effort`. Changes use the existing connection, read back native settings and persist for this parent across reconnects/restarts. They affect subsequent turns and future default-inheriting delegates; active turns and existing delegates retain their settings. Permission changes and arbitrary RPC methods are outside this surface. Unknown context occupancy and remaining capacity stay `null`. See the [capability matrix](docs/POCKET_SESSION_CONTROLS.md).

## Usage reports

Run a local native-record report with an explicit interval or an IANA local calendar day:

```sh
npm run usage -- --day 2026-10-20 --timezone America/Los_Angeles
npm run usage -- --start 2026-10-20T00:00:00-07:00 --end 2026-10-21T00:00:00-07:00 --timezone America/Los_Angeles --format markdown
```

The default roots are `$CODEX_HOME/sessions` (or `~/.codex/sessions`) and `$CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`). Override them with `--codex-dir` and `--claude-dir`. JSON includes per-chat/per-model and ancestry-grouped totals, original token categories, source paths, subset relationships, deduplicated records and missing-coverage notes. Repeated cumulative Codex counters, resumed file copies, inherited fork history and repeated Claude requests are deduplicated. Cloud work appears only when its native records are available locally.

Billed charges and subscription consumption remain unknown. Native reported USD is retained separately. To compute an explicitly labeled token-price estimate, pass `--prices prices.json` containing records like this (replace the illustrative rates and source with dated pricing you intend to use):

```json
[
  {
    "harness": "codex",
    "model": "your-model",
    "currency": "USD",
    "source": "Your dated pricing source",
    "date": "2026-10-20",
    "serviceTier": null,
    "perMillion": {
      "uncached_input_tokens": 1,
      "cached_input_tokens": 0.5,
      "output_tokens": 2
    }
  }
]
```

A missing rate for a used category leaves that estimate unknown. Claude pricing can also include `cache_creation_input_tokens`. Cached/reasoning subset counters are never added twice. Running sessions and incomplete or missing logs can leave the report incomplete.

## Environment variables

| Variable                    | Purpose                                                            | Default                                |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| `CODEX_THREAD_ID`           | The one saved thread to resume                                     | Required                               |
| `CODEX_CWD`                 | Absolute working directory of the host process                     | Repository directory                   |
| `CODEX_BINARY`              | Local Codex executable                                             | `codex`                                |
| `CODEX_ACTIVE_MESSAGE_MODE` | Send during a turn: `steer` or `queue`                             | `steer`                                |
| `CODEX_ALLOWED_ORIGINS`     | Comma-separated allowed origins, without trailing slashes          | Localhost and loopback on port 3000    |
| `CODEX_SERVER_ARGS`         | JSON array of arguments passed directly to Codex                   | `["app-server","--listen","stdio://"]` |
| `CODEX_POCKET_STATE_DIR`    | Local receipts, requests, push keys, schedules, delegates and logs | `.local`                               |
| `POCKET_CLAUDE_BINARY`      | Claude Code executable for Side Pockets                            | Auto-detected                          |
| `POCKET_CLAUDE_MODEL`       | Default Claude child model                                         | Claude configuration                   |

Codex uses its local login and configuration. The bridge sends no per-turn model, sandbox, permission or approval-policy overrides. Configure process-wide overrides with `CODEX_SERVER_ARGS` on the computer. Pocket applies the computer's effective reasoning effort explicitly when resuming a saved thread and starting each new turn, so a saved thread's older effort does not override the selected setting. The header displays the effective model and reasoning effort returned by Codex.

The default transport owns a local `codex app-server` process. It resumes the saved thread at service startup and restarts that process after a disconnect. It cannot steer an unrelated CLI process already running elsewhere. Use this bridge as the thread's active owner. Codex builds that provide a shared daemon can use `CODEX_SERVER_ARGS='["app-server","proxy"]'`; that requires a daemon started separately, and only rejoins threads hosted by that daemon.

Pending sends appear locally before the network round trip. Codex client message IDs reconcile them with confirmed history, including steering messages, without duplicating identical text. Failed or uncertain sends stay visible.

Queue mode persists pending sends across bridge restarts. Delivery receipts deduplicate repeated message IDs. If the process dies before acknowledging a send, its delivery becomes uncertain and the bridge leaves it for inspection in `~/.pocket/data/outbox.json`; it does not replay that message automatically. Check the Codex thread before resolving the local outbox.

Questions, command approvals, file approvals and permission requests are supported on the phone. An unfamiliar request stays pending and asks you to handle it on the computer. To inspect and answer one using the exact app-server response format:

```sh
npm run desktop -- requests
npm run desktop -- respond REQUEST_ID '{"decision":"decline"}'
```

Keep `~/.pocket/` private. The service worker caches the offline page only; conversation history and requests always come from the computer. Drafts stay in browser storage. Phone suspension disconnects the view while Codex continues on the computer; reopening the app restores the conversation.

## Diagnostics

Pocket writes structured Pino JSONL logs under `~/.pocket/logs/`. Each file is named with its ISO creation timestamp, for example `2026-10-19T05:00:00.000Z.jsonl`. It starts a new file before the next record would exceed 10 MiB and keeps the latest 20 files. A single oversized record stays intact in its own file.

Logs cover server startup and errors, HTTP requests and request IDs, SSE connections, message receipt/delivery, Codex RPC requests/responses/events/stderr, push delivery and browser failures. Conversation and tool activity are included for diagnosis. Credential fields are redacted; log files are owner-only and ignored by Git. launchd's startup/stdout fallback remains in `pocket.log` and `pocket.err.log`.

Browser diagnostics are queued locally while Pocket is unreachable and uploaded after reconnecting. Network and non-JSON restart failures retain the message in the composer for retry.

```sh
rg 'http.invalid_response|message.failed|codex.rpc.timeout|bridge.failed|push.failed' ~/.pocket/logs/*.jsonl
```

For an agent diagnosing a failed phone send: read the browser's request/message ID, correlate it with HTTP and Codex RPC logs, then inspect `~/.pocket/data/outbox.json` and the Codex thread before retrying. An uncertain delivery must not be replayed automatically. Check launchd state, local HTTP and any configured HTTPS endpoint, the configured origins and recent server errors if the client is stuck connecting.

Optional environment settings:

| Variable                     | Default          |
| ---------------------------- | ---------------- |
| `CODEX_POCKET_LOG_DIR`       | `~/.pocket/logs` |
| `CODEX_POCKET_LOG_LEVEL`     | `debug`          |
| `CODEX_POCKET_LOG_MAX_BYTES` | `10485760`       |
| `CODEX_POCKET_LOG_MAX_FILES` | `20`             |

## Checks

```sh
npm run check
npm test
npm run build
npm run test:e2e
npm run test:e2e:queue
npm run test:e2e:questions
npm run test:e2e:schedules
npm run test:e2e:images
npm run test:e2e:activity
npm run test:recovery
npm run test:harnesses
npm run test:delegation
```

`npm run lint` runs ESLint with **`--max-warnings=0`**. The root `eslint.config.ts` contains the engineering rules directly, including TypeScript ESLint's `strictTypeChecked` and `stylisticTypeChecked` presets, the unsafe-type-assertion rule, and project-service type information rooted in this repository. The root `prettier.config.mjs` contains the formatting options directly. `npm run typecheck` keeps strict TypeScript and `noImplicitAny` enabled; typed lint also rejects unsafe `any` assignment, member access, calls, and returns. Project-owned TypeScript and TSX, including `src/components/ui/**`, receive typed lint coverage. Generated build output, dependency directories, and local test/cache artifacts are excluded. The two application overrides preserve Node's event API and protocol/storage/React `null` values.

`npm test` runs the complete server/workflow suite with an empty `PATH`, disposable home and no inherited credentials. `npm run test:simulators` selects the reusable native-protocol simulator flows. `npm run test:simulators:native` explicitly runs shared assertions against authenticated Codex and Claude instances. See [the simulator contracts and coverage](docs/POCKET_SIMULATORS.md).

Build first with `npm run build`. Default browser tests use local protocol fixtures on separate test servers. The explicit `test:e2e:live` command enables the real Codex project, makes model calls in a new integration-test thread, and archives it afterward. Install the browser engines with `npx playwright install chromium webkit` if unavailable.

`npm run test:recovery` uses a separate real Codex chat to check an empty start, resumed history, hidden recovery inputs, visible replies, connection deduplication and recovery after stopping an in-progress command. It archives the test chat afterward. Push completed work with normal Git pushes; do not force-push or rewrite remote history.

`npm run test:harnesses` makes real Codex and Claude calls to check unrestricted access, saved-session resume, history and native tool availability. `npm run test:delegation` uses a real Codex parent to create both harnesses, exchange child questions and parent answers, close actual processes and resume the same saved sessions. Both use separate ignored state and require local sign-in.

References: [Codex app-server](https://developers.openai.com/codex/app-server/), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [shadcn chat components](https://ui.shadcn.com/docs/components/base/message-scroller), [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps).

Duplication review uses the committed `.jscpd.json` with similarity `0.7`, normalized identifiers/literals/annotations, up to two gap lines and JavaScript/TypeScript cross-format matching. Run `npm run review:duplicates` and `npm run review:dead-code`; reports stay under ignored `.local/review/jscpd`. Findings require source/caller review. Generated and dependency artifacts are excluded; authored source and tests remain included.
