# Pocket

A small phone interface for one Codex thread running on your computer. Messages stream live. Tool activity appears as a small muted spinner. Sends appear immediately in a muted bubble and become solid when Codex acknowledges them. Codex can ask questions and request approvals in the conversation.

Built with Next.js, Tailwind CSS and shadcn/ui. Session selection and behavior belong to the computer; the phone has a conversation and a send button.

## Agent setup on macOS

Follow these steps from the repository on the computer that will run Codex. Keep its `.env.local`, thread selection and service configuration local to that computer.

### 1. Check the computer

You need npm, a Codex CLI signed in with app-server support, and Tailscale connected to the phone's tailnet. This bridge was checked against `codex-cli 0.163.0-alpha.10.2`. Clone the private repository under `~/Developer/codex-pocket` if it is missing, then enter it.

```sh
cd "$HOME/Developer/codex-pocket"
export CODEX_BINARY="$(command -v codex)"
"$CODEX_BINARY" login status
tailscale status
tailscale serve status --json
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

An empty `lsof` result means port 3000 is available. If something owns it, identify it before continuing. Preserve existing Tailscale routes; do not reset Serve or overwrite another service's root HTTPS route.

Use Node.js 24. If the computer's default Node is older, install a persistent repository-local runtime:

```sh
npm install --prefix .local/runtime --package-lock=false --no-audit --no-fund node@24
export PATH="$PWD/.local/runtime/node_modules/node/bin:$PATH"
node --version
npm ci
```

Use this PATH for every command below. The service installer records the current Node executable's absolute path, so it must point to a persistent runtime.

### 2. Configure one thread

Derive the computer's HTTPS origin and choose an absolute working directory:

```sh
export POCKET_ORIGIN="$(tailscale status --json | python3 -c 'import json,sys; print("https://" + json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
export CODEX_CWD="$HOME/Developer"
```

Model, effort and permissions are configured on the computer through `CODEX_SERVER_ARGS` or the local Codex configuration. For an unrestricted deployment explicitly requested by the operator, this profile selects **gpt-6.1-sol**, **xhigh**, unrestricted command/filesystem access and no approval prompts:

```sh
export CODEX_SERVER_ARGS='["app-server","--listen","stdio://","-c","model=\"gpt-6.1-sol\"","-c","model_reasoning_effort=\"xhigh\"","-c","sandbox_mode=\"danger-full-access\"","-c","approval_policy=\"never\""]'
```

These overrides apply to Pocket's Codex process. They do not edit the computer's global Codex configuration. With `CODEX_SERVER_ARGS` unset, a fresh setup inherits the local Codex settings.

For a first setup, create a dedicated saved thread:

```sh
POCKET_THREAD_ID='' npm run setup
```

The setup command starts a real Codex process, names the thread Pocket, runs a short welcome turn and writes `.env.local` with owner-only permissions. It prints the effective model, effort, sandbox and approval policy. It also adds the Tailscale origin to `CODEX_ALLOWED_ORIGINS`. Verify the printed settings against the operator's request.

To select an existing saved thread, use `POCKET_THREAD_ID=YOUR_THREAD_ID npm run setup`. The setup helper deliberately ignores the shell's inherited `CODEX_THREAD_ID`, which Codex injects for its own conversation. Running `npm run setup` without `POCKET_THREAD_ID` preserves the thread already saved in `.env.local` and updates the other supplied values. Do not create a new thread on routine restarts or updates.

For manual setup, copy `.env.example` to `.env.local`, then fill in `CODEX_THREAD_ID`, `CODEX_CWD`, `CODEX_BINARY` and the allowed origins. The phone has no session settings.

### 3. Build and install the service

```sh
npm run check
npm test
npm run build
npm run service:install
launchctl print "gui/$(id -u)/dev.pocket.web"
curl --fail http://127.0.0.1:3000 > /dev/null
```

Allow a few seconds for startup before the HTTP check. The installer creates `~/Library/LaunchAgents/dev.pocket.web.plist` and starts Pocket on `127.0.0.1:3000`. It runs at login and restarts after a crash. The service uses launchd’s Interactive process class so macOS does not throttle chat requests and Codex as background maintenance work. The Mac must remain awake and the user must remain logged in.

### 4. Serve privately through Tailscale

Once local HTTP responds, and the root HTTPS route is available:

```sh
tailscale serve --bg --yes http://127.0.0.1:3000
tailscale serve status --json
curl --fail "$POCKET_ORIGIN" > /dev/null
```

Use Tailscale Serve for private tailnet access. Check that the route targets `http://127.0.0.1:3000` and Funnel is disabled. If Tailscale requires enabling HTTPS, complete the action printed by its CLI and rerun the command.

Connect the phone to the same tailnet, open `POCKET_ORIGIN` and add it to the home screen. Tailnet access grants control of the configured Codex thread; the app has no separate account system. Set tailnet ACLs for the intended operators. Pocket checks request hosts and mutation origins.

### 5. Verify the running deployment

Open the HTTPS URL in a mobile browser or a mobile browser emulator. Confirm the title is Pocket, the model/effort match the requested profile and the connection is live. Send a harmless message through the UI and confirm a real reply. The outgoing bubble should appear immediately, become solid after acknowledgment and appear on a second connected client without a refresh. Replies and the activity spinner update through server-sent events.

Check the effective permission settings printed during setup and the actual service process arguments. Verify history returns after a page reload and an idle service restart. Do not interrupt an active Codex turn to deploy an update. Report the HTTPS URL, chosen working directory, model/effort, access policy and checks performed to the operator. Do not commit `.env.local`, `.local/`, local thread IDs or machine-specific URLs.

## Operate and update

Restart after editing `.env.local`:

```sh
launchctl kickstart -k "gui/$(id -u)/dev.pocket.web"
```

Logs are in `.local/logs/pocket.log` and `.local/logs/pocket.err.log`. To inspect service state, use `launchctl print "gui/$(id -u)/dev.pocket.web"`.

Before updating dependencies or rebuilding an installed deployment, wait for Codex to finish its active turn, then stop Pocket's service. This prevents the running server from serving a partially replaced build:

```sh
launchctl bootout "gui/$(id -u)/dev.pocket.web"
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Wait until port 3000 has no listener before continuing:

```sh
git pull --ff-only
npm ci
npm run check
npm test
npm run build
npm run service:install
```

Recheck local HTTP, HTTPS and resumed history after the update. Tailscale's existing Serve route stays in place. To remove only this root HTTPS proxy, use `tailscale serve --https=443 off` after checking that it is still Pocket's route.

For development, use `npm run dev`. For a foreground production server, use `npm start` after building; both bind to loopback. Restart after changing environment variables.

## Notifications

On the first visit, Pocket offers an **Enable notifications** button. Tap it to open the browser's permission prompt. On iPhone or iPad, first add Pocket to the Home Screen and open it from that icon; a regular Safari tab cannot request Web Push permission.

Pocket sends an encrypted Web Push notification when Codex ends a turn, including when the app is closed. Tapping the notification opens or focuses Pocket. Notification text says that Pocket finished or stopped; it does not include conversation content. The Mac must be awake with Pocket running. Delivery also depends on the device's notification settings and push service.

VAPID keys, device subscriptions and notification receipts are generated automatically and saved privately in `.local/push.json`. Keep this file across restarts and deployments. Deleting it invalidates existing device subscriptions, which must then be enabled again. Expired subscriptions are removed when their push service rejects them. No API key or paid notification service is needed.

After setup, enable notifications on the actual phone, send a harmless message, close the PWA and verify that a notification arrives when Codex finishes. This device permission and delivery check must happen on the phone; a desktop browser emulator does not verify iOS notification delivery.

## Scheduled tasks

Pocket starts its owned Codex process when the service starts, even without an open phone client. It appends Pocket identity and scheduling instructions to the configured developer instructions, and adds a bundled `pocket` MCP server to that process only. The bundled scheduling tools are preapproved so future tasks can run unattended. It does not edit the global Codex configuration.

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

When due, Pocket injects the body into the real Codex chat using the same steering/queueing mode as phone messages. The phone shows a muted clock marker, **Scheduled task · title**, instead of the injected user-message body. The agent can still mention the task's details in its response. A one-time event becomes inactive after it fires.

Schedules and immutable delivery history live in owner-private `.local/schedules.sqlite` with SQLite WAL. Keep the database and its `-wal`/`-shm` files across updates; use SQLite backup facilities for a consistent live backup. Deleting a task cancels future occurrences and pending deliveries, while preserving historical markers. Messages already accepted or in flight cannot be recalled.

Tasks run only while this Mac is awake and Pocket is running. After downtime, Pocket sends one overdue occurrence per task and advances a repeated task to its next future occurrence; it does not flood the chat with every missed repetition. Restart recovery reuses each run's durable message ID. An uncertain Codex acknowledgment is retained for inspection rather than automatically replayed. Diagnose `schedule.*` events alongside the matching outbox receipt before retrying anything.

## Environment variables

| Variable                    | Purpose                                                   | Default                                |
| --------------------------- | --------------------------------------------------------- | -------------------------------------- |
| `CODEX_THREAD_ID`           | The one saved thread to resume                            | Required                               |
| `CODEX_CWD`                 | Absolute working directory of the host process            | Repository directory                   |
| `CODEX_BINARY`              | Local Codex executable                                    | `codex`                                |
| `CODEX_ACTIVE_MESSAGE_MODE` | Send during a turn: `steer` or `queue`                    | `steer`                                |
| `CODEX_ALLOWED_ORIGINS`     | Comma-separated allowed origins, without trailing slashes | Localhost and loopback on port 3000    |
| `CODEX_SERVER_ARGS`         | JSON array of arguments passed directly to Codex          | `["app-server","--listen","stdio://"]` |
| `CODEX_POCKET_STATE_DIR`    | Local receipts, requests, push keys, schedules and logs   | `.local`                               |

Codex uses its local login and configuration. The bridge sends no per-turn model, sandbox, permission or approval-policy overrides. Configure process-wide overrides with `CODEX_SERVER_ARGS` on the computer. The header displays the effective model and reasoning effort returned by Codex.

The default transport owns a local `codex app-server` process. It resumes the saved thread at service startup and restarts that process after a disconnect. It cannot steer an unrelated CLI process already running elsewhere. Use this bridge as the thread's active owner. Codex builds that provide a shared daemon can use `CODEX_SERVER_ARGS='["app-server","proxy"]'`; that requires a daemon started separately, and only rejoins threads hosted by that daemon.

Pending sends appear locally before the network round trip. Codex client message IDs reconcile them with confirmed history, including steering messages, without duplicating identical text. Failed or uncertain sends stay visible.

Queue mode persists pending sends across bridge restarts. Delivery receipts deduplicate repeated message IDs. If the process dies before acknowledging a send, its delivery becomes uncertain and the bridge leaves it for inspection in `.local/outbox.json`; it does not replay that message automatically. Check the Codex thread before resolving the local outbox.

Questions, command approvals, file approvals and permission requests are supported on the phone. An unfamiliar request stays pending and asks you to handle it on the computer. To inspect and answer one using the exact app-server response format:

```sh
npm run desktop -- requests
npm run desktop -- respond REQUEST_ID '{"decision":"decline"}'
```

Keep `.env.local` and `.local/` private. The service worker caches the offline page only; conversation history and requests always come from the computer. Drafts stay in browser storage. Phone suspension disconnects the view while Codex continues on the computer; reopening the app restores the conversation.

## Diagnostics

Pocket writes structured Pino JSONL logs under `.local/logs/`. Each file is named with its ISO creation timestamp, for example `2026-10-19T05:00:00.000Z.jsonl`. It starts a new file before the next record would exceed 10 MiB and keeps the latest 20 files. A single oversized record stays intact in its own file.

Logs cover server startup and errors, HTTP requests and request IDs, SSE connections, message receipt/delivery, Codex RPC requests/responses/events/stderr, push delivery and browser failures. Conversation and tool activity are included for diagnosis. Credential fields are redacted; log files are owner-only and ignored by Git. launchd's startup/stdout fallback remains in `pocket.log` and `pocket.err.log`.

Browser diagnostics are queued locally while Pocket is unreachable and uploaded after reconnecting. Network and non-JSON restart failures retain the message in the composer for retry.

```sh
rg 'http.invalid_response|message.failed|codex.rpc.timeout|bridge.failed|push.failed' .local/logs/*.jsonl
```

For an agent diagnosing a failed phone send: read the browser's request/message ID, correlate it with HTTP and Codex RPC logs, then inspect `.local/outbox.json` and the Codex thread before retrying. An uncertain delivery must not be replayed automatically. Check launchd state, both HTTP endpoints, the configured origins and recent server errors if the client is stuck connecting.

Optional environment settings:

| Variable                     | Default       |
| ---------------------------- | ------------- |
| `CODEX_POCKET_LOG_DIR`       | `.local/logs` |
| `CODEX_POCKET_LOG_LEVEL`     | `debug`       |
| `CODEX_POCKET_LOG_MAX_BYTES` | `10485760`    |
| `CODEX_POCKET_LOG_MAX_FILES` | `20`          |

## Checks

```sh
npm run check
npm test
npm run build
npm run test:e2e
npm run test:e2e:queue
npm run test:e2e:questions
```

`npm run lint` runs ESLint with **`--max-warnings=0`**. ESLint and Prettier use the configs and pinned dependencies bundled with `jdeurt-engineering` 1.2.0. Their source lives in `tooling/engineering/`; the `.mjs` ESLint file is compiled from the bundled TypeScript source. Generated shadcn components and bundled tooling are excluded from application lint; Prettier checks the component source. The application uses the shared non-type-aware ESLint rules together with a separate strict TypeScript check. The two overrides preserve Node's event API and protocol/React `null` values.

Build first with `npm run build`. Browser tests use the real installed Codex process, make model calls in a new integration-test thread, and archive that thread afterward. They use port 3101 and a separate ignored state directory. Install Playwright's Chromium once with `npx playwright install chromium` if it is unavailable.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [shadcn chat components](https://ui.shadcn.com/docs/components/base/message-scroller), [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
