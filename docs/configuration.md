# Configuration and troubleshooting

The installer saves host settings in `~/.pocket/.env.local`. Edit runtime settings on the Mac, then run `pocket restart`. For the service port or state/log directories, run `pocket update` so the installer also rebuilds the login-service definition. Keep it private. Agent permissions, native login, and tool configuration belong on the computer.

## Pocket Settings

Open the top-left **Pockets** menu and select the **Settings** gear. This central area contains Pocket preferences, including **Show tool calls**, realtime voice/model overrides, and the **OpenAI API key** option for advanced functionality, including realtime. These settings are global across Pockets. Per-conversation model and reasoning-effort controls remain available through [session tools](session-controls.md).

Enter a key to save or replace it, or select **Remove saved key**. Pocket never sends a saved key back to the browser or stores it in browser storage. It saves the key and preferences in `settings.json` inside `CODEX_POCKET_STATE_DIR` (normally `~/.pocket/data`) with private file permissions and atomic replacement. This is local plaintext storage, so protect the host and its backups. No provider request is made when saving a key.

A saved key takes precedence over the optional host `OPENAI_API_KEY` environment variable. Removing the saved key restores that fallback; remove the environment variable on the host and restart Pocket to disable it too. Settings shows which source is active. Provider sessions should read current settings when starting; a session already running may retain its original key.

**Realtime voice** and **Realtime model** are optional provider identifiers. Leave either field blank and save to restore that provider default. Changes apply to the next realtime session. Settings validates identifier syntax; the voice transport checks availability when starting a session.

### Shared consumer contract

- `src/lib/settings.ts` exports `PocketSettings`, `pocketSettingsSchema`, `PocketSettingsMutation`, and `pocketSettingsMutationSchema`.
- `GET /api/settings` and successful `POST /api/settings` return `{ showToolCalls: boolean, realtimeVoice: string | null, realtimeModel: string | null, openaiApiKeyConfigured: boolean, openaiApiKeySource: "saved" | "environment" | null }`, with `Cache-Control: no-store`. `showToolCalls` defaults to `false`; both realtime overrides default to `null` (use provider defaults).
- POST accepts a nonempty strict partial object `{ showToolCalls?: boolean, realtimeVoice?: string | null, realtimeModel?: string | null, openaiApiKey?: string | null }`. Omitted fields are preserved; explicit `null` clears a key or override. Keys are trimmed, nonempty, at most 4096 characters, and contain no internal whitespace. Realtime identifiers are trimmed, nonempty, at most 120 characters, and contain only letters, digits, underscore, dot, or hyphen. Provider availability is validated by the voice lane, which owns the catalog and defaults. Mutations use the existing host/origin and JSON-body guards. Updates are serialized to preserve simultaneous edits to different fields.
- Failures return HTTP 400 and `{ error: string }`: GET uses `Could not load Pocket settings.`; POST uses `Could not save Pocket settings. Check your input and try again.` Credential-bearing parse errors are replaced before logging or responding.
- `src/server/pocket-settings.ts` exports async `readPocketSettings()` for public status and realtime overrides, `updatePocketSettings(input)` for partial persistence, and `readOpenAIApiKey(): Promise<string | null>` for server-only consumers. Pi and voice should call the readers when creating provider sessions, keep the key on the host, and handle a missing key with an actionable Settings message. Voice should resolve null overrides through its own provider defaults. This module requires Node filesystem access; never import it into client code.
- `src/hooks/use-pocket-settings.ts` exports `usePocketSettings()` with `{ data, error }` and `savePocketSettings(change)` for validated browser reads and updates. Readers poll and refresh on reconnect or visibility changes; successful local saves wake them immediately. Chat owns applying `data?.showToolCalls ?? false` to main transcript tool rendering.
- Add future preference controls to `PocketSettingsPanel` in `src/components/pocket-settings.tsx` and extend these shared schemas and persistence together. Keep provider-specific behavior in its owning lane.

## Installer inputs

Export these values before running the [installer](installation.md), or supply them to `pocket update`. Unspecified values reuse saved settings where available.

| Variable            | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `POCKET_CWD`        | Working folder; defaults to the saved folder or `~/.pocket/workspace`            |
| `POCKET_ORIGIN`     | Optional phone HTTPS origin, such as `https://pocket.example.com`                |
| `POCKET_PORT`       | Local service port; defaults to the saved port or `3000`                         |
| `POCKET_THREAD_ID`  | Saved Codex thread to select; an explicit empty value creates a new conversation |
| `CODEX_BINARY`      | Preferred Codex executable; otherwise detected or installed                      |
| `CODEX_SERVER_ARGS` | JSON array of process arguments; otherwise saved arguments or Codex defaults     |

For example, to use a particular folder and phone address on the next update:

```sh
export POCKET_CWD="$HOME/Developer/my-project"
export POCKET_ORIGIN="https://pocket.example.com"
pocket update
```

Creating another conversation from the **Pockets** menu is usually simpler than changing `POCKET_THREAD_ID`. For an explicit new setup conversation, use `POCKET_THREAD_ID='' pocket update`.

## Runtime settings

These values configure the host process. The installer writes absolute paths for the installed service; a manual development checkout needs its own configuration.

| Variable                    | Purpose and default                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| `CODEX_THREAD_ID`           | Original saved conversation; required to attach the host                     |
| `CODEX_CWD`                 | Absolute working directory; defaults to `~/.pocket/workspace`                |
| `CODEX_BINARY`              | Codex executable; defaults to `codex` outside the installer                  |
| `CODEX_ACTIVE_MESSAGE_MODE` | `steer` (default) corrects active work; `queue` waits for the turn to finish |
| `CODEX_ALLOWED_ORIGINS`     | Comma-separated origins; defaults to localhost and loopback on port 3000     |
| `CODEX_SERVER_ARGS`         | Defaults to `["app-server","--listen","stdio://"]`                           |
| `CODEX_POCKET_STATE_DIR`    | Pocket data directory; defaults to `~/.pocket/data`                          |
| `POCKET_CLAUDE_BINARY`      | Optional explicit Claude Code executable for delegates                       |
| `POCKET_CLAUDE_MODEL`       | Default Claude delegate model; otherwise Claude's configuration              |

Origins must contain no trailing slash, path, query, or fragment. An allowed origin is a request guard, not a login system; protect remote access at the proxy or network boundary.

Main conversations use Pi and the central OpenAI key. Pi tools run within the host process's existing machine and environment permissions; Codex sandbox and approval settings do not constrain Pi. Codex uses its local login and configuration for native delegates, legacy bootstrap and history access. Use Pocket as that conversation's active owner. To work with a session owned elsewhere, follow [existing-session attachment](side-pockets.md#connect-an-existing-codex-session).

The installer offers native Codex permissions or explicit unrestricted access for native work. These choices do not sandbox the Pi main session. To configure unrestricted native Codex access through process arguments:

```sh
export CODEX_SERVER_ARGS='["app-server","--listen","stdio://","-c","sandbox_mode=\"danger-full-access\"","-c","approval_policy=\"never\""]'
pocket update
```

This configures native Codex work to run without sandbox restrictions or approval prompts. Main Pi model and reasoning choices use [Pocket's session tools](session-controls.md) and its model catalog; native delegate defaults remain independent. Session inspection reports the Pi execution boundary, and the header shows the main model and effort.

## Delivery and restart recovery

Messages have durable IDs so reconnects can reconcile a pending send with confirmed history. If the process stops before acknowledging a send, its outcome is uncertain. Pocket retains the record for inspection rather than replaying work automatically. Check the saved harness history and relevant outbox receipt before retrying.

When Pocket resumes a conversation with history, Pocket sends one hidden recovery instruction through the same durable delivery system. It asks the agent to continue unfinished work and inspect expected delegates. Empty chats and browser reconnects do not trigger it. Pending recovery messages reuse their IDs; uncertain ones stay unresolved. Look for `recovery.queued` in the logs.

Pocket adds its instructions while preserving existing developer instructions and saved history. A migrated conversation may retain earlier instructions. Create a new Pocket when you need a clean instruction context.

Questions and supported command, file, and permission approvals appear on the phone. An unfamiliar request stays pending for handling on the computer. From a configured checkout, inspect requests or answer using the exact native response format:

```sh
npm run desktop -- requests
npm run desktop -- respond REQUEST_ID '{"decision":"decline"}'
```

For another named Pocket, set `POCKET_ID` to the identity in its URL. These scripts need that installation's configuration; a fresh development checkout does not automatically target the installed service. Response formats vary by request type.

## Troubleshooting

**`pocket` is not found.** Open a new terminal, or run `export PATH="$HOME/.pocket/bin:$PATH"`. For shells other than zsh or bash, add that directory to the shell's startup configuration.

**The phone stays on Connecting.** Check the local page at `http://127.0.0.1:3000`, then the HTTPS address. Inspect the login service and startup errors:

```sh
launchctl print "gui/$(id -u)/dev.pocket.web"
tail -n 50 ~/.pocket/logs/pocket.err.log
```

If local access works, check the tunnel, allowed origin, and unbuffered event-stream connections. If it fails locally, inspect the recent structured logs and Codex login. Use `pocket start` if the service is stopped.

**The UI is old after an update.** Current clients detect a changed build automatically. Finish any send, upload, or name edit so refresh can proceed. A client from before automatic updates needs a manual refresh once. Check that `pocket update` actually activated the new release; a failed candidate leaves the prior release running.

**A send failed or may have been delivered.** Correlate its request/message ID with HTTP and Codex logs, then inspect saved history and the receipt under `~/.pocket/data/`. The original host outbox is `outbox.json`; named Pocket outboxes are `pockets/<Pocket ID>/outbox.json`. Do not resubmit uncertain work until you know whether it was accepted.

**An update is locked.** Confirm no installer is running before removing a stale lock directory. See [updates and rollback](installation.md#updates-and-rollback).

## Logs and private data

Pocket writes timestamped JSONL logs under `~/.pocket/logs/`. Logs include HTTP requests, message delivery, native RPC activity, push delivery, browser failures, and conversation/tool content. Credential fields are redacted, but the remaining content can still be sensitive. Review it before sharing.

Each structured log rotates before the next record would exceed 10 MiB; the latest 20 files are retained. An oversized record stays intact in its own file. Service startup output also appears in `pocket.log` and `pocket.err.log`. Browser diagnostics queue locally while disconnected and upload after reconnecting.

```sh
rg 'http.invalid_response|message.failed|codex.rpc.timeout|bridge.failed|push.failed' ~/.pocket/logs/*.jsonl
```

| Variable                     | Installed default |
| ---------------------------- | ----------------- |
| `CODEX_POCKET_LOG_DIR`       | `~/.pocket/logs`  |
| `CODEX_POCKET_LOG_LEVEL`     | `debug`           |
| `CODEX_POCKET_LOG_MAX_BYTES` | `10485760`        |
| `CODEX_POCKET_LOG_MAX_FILES` | `20`              |

Outside the installed service, the log directory defaults to `logs/` inside `CODEX_POCKET_STATE_DIR`. Set an explicit log path when isolating a development checkout.

Keep `~/.pocket` private and preserve native harness session stores. The service worker caches the offline page; conversation history and requests come from the host. Browser storage holds drafts and pending attachment data.
