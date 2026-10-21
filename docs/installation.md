# Installation and updates

Pocket's installer supports macOS on Apple silicon and Intel. It uses a per-user login service, so the Mac must be awake and your user logged in for agents, schedules, and notifications to run.

## Install on your Mac

You need `git`, `curl`, internet access, and a Codex account. The public repository can be downloaded without GitHub authentication.

```sh
curl -fsSL https://raw.githubusercontent.com/jdeurt/codex-pocket/main/install.sh | bash
```

The installer downloads and checksums a private Node.js 24 runtime. It finds a local Codex executable, including one bundled with the Codex app, or installs Codex privately. It guides first-time sign-in and asks for a working folder, an optional phone HTTPS address, and permissions. The default working folder is `~/.pocket/workspace`; choose a project directory if you want the agent to work there.

First setup creates a saved conversation and makes a short model call to confirm it works. Updates reuse the saved conversation. Setup writes private settings without changing your global Codex configuration or importing another Pocket checkout's data.

You can also run `./install.sh` from a checkout. Both entry points fetch the latest `main` into `~/.pocket/source` before building.

For unattended setup, sign in to Codex first, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/jdeurt/codex-pocket/main/install.sh | bash -s -- --yes
```

`--yes` uses saved settings or defaults. To supply setup values, export them before running the installer; see [configuration](configuration.md#installer-inputs).

## Connect your phone

1. Configure an HTTPS reverse proxy or tunnel to reach Pocket at `http://127.0.0.1:3000` on the Mac.
2. Protect the HTTPS address with access controls for the people who should operate the agents. Pocket has no separate account system.
3. Enter the HTTPS origin during installation. If Pocket is already installed, add it to the comma-separated `CODEX_ALLOWED_ORIGINS` value in `~/.pocket/.env.local`, then run `pocket restart`.
4. Open the HTTPS address on your phone. Add it to the Home Screen if you want to use it as an installed web app.

An origin looks like `https://pocket.example.com`, with no trailing slash, path, query, or fragment. Keep the existing localhost origins when adding yours. The proxy must preserve the external Host/Origin headers and allow long-lived server-sent event connections without response buffering. Setting an allowed origin does not create a tunnel or change network access controls.

Pocket binds to loopback. It can be used on the Mac without a phone address. On iPhone and iPad, open the Home Screen app before [enabling notifications](using-pocket.md#notifications).

## CLI commands

The installer creates `~/.pocket/bin/pocket` and adds that directory to zsh or bash startup settings. Open a new terminal, or update the current one:

```sh
export PATH="$HOME/.pocket/bin:$PATH"
```

For another shell, add `~/.pocket/bin` to its executable search path.

| Command                 | Effect                                                                |
| ----------------------- | --------------------------------------------------------------------- |
| `pocket update`         | Fetch latest `main`, build and validate a candidate, then activate it |
| `pocket start`          | Start the saved login service; do nothing if it is already running    |
| `pocket stop`           | Stop the service while keeping configuration and data                 |
| `pocket restart`        | Restart the saved release, or start it if stopped                     |
| `pocket --help`         | Show command help                                                     |
| `pocket menubar setup`  | Build and start the menu bar companion, and enable launch at login    |
| `pocket menubar remove` | Remove the menu bar companion and its login startup                   |

Menu bar setup requires macOS 13 or later and Apple's Command Line Tools (`xcode-select --install`).
Click the icon to show or hide the existing Pocket interface. Clicking outside or pressing Escape also hides it.
The page stays loaded while hidden.
Drag a window edge or corner to resize it. The chosen size is saved for the next launch.
The native window supports normal keyboard focus and text editing and does not show notification banners.
The companion uses Pocket's saved local port. Run setup again after changing the port or updating the companion.
Its app lives at `~/.pocket/menubar/Pocket.app`, with login startup in
`~/Library/LaunchAgents/dev.pocket.menubar.plist`. Setup and removal do not restart the web service or change Pocket data.

Wait for active agent work before an update or restart unless interruption is intended. After editing runtime settings in `~/.pocket/.env.local`, run `pocket restart`. Port and state/log-directory changes need `pocket update` to regenerate the login service.

## Updates and rollback

Dependency installation, checks, production compilation, and setup finish in an isolated release directory before the running service stops. A build failure discards the candidate and leaves the current service intact. A launch failure triggers restoration of the previous configuration, release selection, and login service. If recovery itself fails, the installer reports it and retains the release files for diagnosis.

Open clients check for a new build every 15 seconds, on reconnect, and on return to the foreground. They refresh after saved text and attachments are safe. Active sends, uploads, unsaved browser storage, text composition, and Pocket-name editing defer refresh. An uncertain send remains visible for reconciliation. A restart of the same build reconnects without reloading the page. A client that predates this feature needs one manual refresh to acquire it.

Concurrent installers are locked out, and updates refuse to overwrite edits in `~/.pocket/source`. If an installer was forcibly terminated, confirm it has exited before removing a stale `~/.pocket/bootstrap.lock` or `~/.pocket/install.lock` directory and retrying.

## Files and service

| Location               | Contents                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `~/.pocket/.env.local` | Shared host configuration                                                               |
| `~/.pocket/data/`      | Pocket catalog, delivery records, uploads, schedules, delegates, and push subscriptions |
| `~/.pocket/logs/`      | Structured diagnostics and service startup logs                                         |
| `~/.pocket/workspace/` | Default working directory                                                               |
| `~/.pocket/source/`    | Managed source checkout                                                                 |
| `~/.pocket/releases/`  | Built releases retained for recovery                                                    |
| `~/.pocket/current`    | Link selecting the accepted release                                                     |
| `~/.pocket/runtimes/`  | Private Node.js runtimes                                                                |
| `~/.pocket/codex/`     | Private Codex installation, when needed                                                 |
| `~/.pocket/bin/`       | CLI launcher                                                                            |

Native Codex and Claude Code sessions remain in their own stores. Keep those alongside Pocket data when backing up. Pocket shares persistent data across releases; a build does not replace it. Use SQLite backup facilities for consistent live database backups, or stop Pocket before copying databases and their associated `-wal` and `-shm` files.

The login service is `dev.pocket.web`, with its definition at `~/Library/LaunchAgents/dev.pocket.web.plist`. It starts at login and restarts after a crash. Inspect its state with:

```sh
launchctl print "gui/$(id -u)/dev.pocket.web"
```

For connection or startup failures, see [troubleshooting](configuration.md#troubleshooting). For source changes, use a separate [development checkout](testing.md#run-a-development-checkout); leave the managed source and accepted releases alone.
