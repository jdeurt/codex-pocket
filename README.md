# Pocket

Pocket lets you work with Codex on your computer from your phone. Send a task, follow its progress, answer questions, and read the result without staying at your desk. The agents run on your computer and use its files, tools, and configured permissions.

You can keep separate named conversations, delegate work to Codex or Claude Code in **Side Pockets**, and bring existing Codex sessions into Pocket. Messages stream live, and the phone app supports file attachments, scheduled tasks, and push notifications.

## Install

The installer supports macOS on Apple silicon and Intel. You need working `git` and `curl` commands, an internet connection, and a Codex account to sign in. It installs a private Node.js runtime and finds or installs Codex for you.

Run in a terminal on your Mac:

```sh
curl -fsSL https://raw.githubusercontent.com/jdeurt/codex-pocket/main/install.sh | bash
```

Follow the prompts to sign in to Codex, choose a working folder and permissions, and optionally enter your phone's HTTPS address. Setup builds Pocket, creates its first conversation, and starts a service that runs when you log in. Open [localhost:3000](http://localhost:3000) on the Mac to try it.

Pocket keeps its installation, settings, logs, and default working folder under `~/.pocket`. Codex and Claude Code keep their own native session storage. See [installation and updates](docs/installation.md) for unattended setup, storage paths, and recovery.

## Use it on your phone

Connect an HTTPS reverse proxy or tunnel to `http://127.0.0.1:3000`, then open that HTTPS address on your phone. Pocket does not set up the tunnel for you. Add the address during installation or follow the [phone connection instructions](docs/installation.md#connect-your-phone).

Protect the address with your proxy or network's access controls: Pocket has no separate account system, and access allows control of its agents. The Mac must stay awake with your user logged in.

Add Pocket to your Home Screen for an app-like experience. On iPhone or iPad, open it from that icon before enabling notifications.

## CLI

Open a new terminal after installation, then run these commands from any directory:

```sh
pocket update  # Pull latest main, build and check it, then switch releases
pocket start   # Start Pocket
pocket stop    # Stop Pocket; keep settings and data
pocket restart # Restart the installed release
pocket --help  # Show available commands
```

For a menu bar icon that opens and closes Pocket in a small window, run `pocket menubar setup`.
This builds the macOS companion, starts it, and enables launch at login. It requires macOS 13 or later
and Apple's Command Line Tools (`xcode-select --install`). Run `pocket menubar remove` to remove the companion
and its login startup.

If `pocket` is not found, run `export PATH="$HOME/.pocket/bin:$PATH"`. The installer adds this directory to zsh or bash startup settings; other shells need it added manually.

Updates build before stopping the running service. A failed build leaves it running; a failed launch triggers rollback to the previous release. Wait for active work to finish before updating or restarting unless you intend to interrupt it. Open phone clients detect new builds and refresh when their drafts and pending sends are safe.

## Learn more

- [Using Pocket](docs/using-pocket.md): named conversations, activity, notifications, and files.
- [Side Pockets and existing sessions](docs/side-pockets.md): delegate tasks or connect a saved or running Codex session.
- [Scheduled tasks](docs/schedules.md): ask Pocket to do work later.
- [Configuration and troubleshooting](docs/configuration.md): host settings, logs, and delivery recovery.
- [Development and testing](docs/testing.md): run a checkout and test with offline simulators or real agents.
- [All documentation](docs/README.md): user guides and technical references.

Pocket is built with Next.js, React, Tailwind CSS, and shadcn/ui.
