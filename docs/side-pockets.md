# Side Pockets

A main Pocket can delegate a task to a separate **Side Pocket** running Codex or Claude Code. Ask it to delegate work, and name the agent you want when that matters. The child keeps its own conversation and sends questions, progress, and results back to the parent.

Main Pockets run Pi; see the [migration support and permission limits](pi-main-context.md). Side Pockets are delegated workers, separate from the named conversations in the top-left Pockets menu.

## Start and follow delegated work

Ask for a task with a clear outcome, for example: “Have a Codex Side Pocket review the changes in this project and report any bugs. Do not edit files.” Give a different working folder when needed; children default to the parent's folder. For concurrent code changes, use separate worktrees or agree which files each agent owns.

Open the agents hint in the status row to browse agents and their conversations. Incoming reports appear as collapsed, single-line previews. Expand one to read the original text, then choose **Open Side Pocket** to view its read-only chat. Your main draft and reading position are preserved. Reports are not paraphrased.

Previously read history appears from a cache while it refreshes. Cold conversations use skeleton placeholders; errors and empty histories show explanatory messages.

Pocket runs up to eight child turns concurrently across both harnesses, excluding main conversations. Follow-up work for the same child stays sequential. Corrections steer an active Codex turn; active Claude steering is unsupported. Explicitly queue a distinct later task when you want it to wait.

## Claude Code setup and permissions

Claude delegation requires Claude Code installed and signed in on the Mac. Pocket discovers its executable or uses `POCKET_CLAUDE_BINARY` from `~/.pocket/.env.local`. `POCKET_CLAUDE_MODEL` sets the default Claude model; a model chosen for a particular child takes precedence. Codex children inherit the parent's model by default. Children inherit reasoning effort, with Codex `minimal` mapped to Claude `low`.

Codex children use the parent's native sandbox and approval policy. Claude currently requires the parent to use `danger-full-access` with approval policy `never`; Pocket maps that to Claude `bypassPermissions`, permission skipping, and a disabled sandbox. It rejects other profiles because it cannot map their restrictions exactly. This gives Claude unrestricted access without approval prompts. Check the intended policy before enabling it.

## Connect an existing Codex session

### Adopt a saved session

Ask Pocket to find saved Codex sessions, then adopt the selected thread ID under a name. It appears in the Agents view with its original transcript. Adoption itself sends no assignment; later messages resume the same session with delegate tracking and reports.

Stop using the session in its other window before handing it to Pocket. A thread ID alone cannot establish whether another process is still using it.

### Attach to running work

A running session requires access to the **app-server that already owns it**. Supply its absolute Unix socket path as `socketPath` to `side_pocket_adopt`; the server must already have the thread loaded. Pocket subscribes to that session, watches its current turn, and reports the result without starting another turn.

An app-server can expose this transport with `--listen unix:///absolute/path/codex.sock`. Starting a new server cannot expose a session already running in another process, and a thread ID cannot attach Pocket to an ordinary standalone CLI process. See the [Codex app-server transport reference](https://learn.chatgpt.com/docs/app-server).

The owning server keeps its model, permissions, tools, and approval handling. Pocket observes completion itself rather than injecting `message_parent`. Corrections use native conditional steering; later assignments use the same owner. Closing this attachment disconnects Pocket and cancels its queued work without interrupting or archiving the original session.

After a disconnect, or to observe a later turn started in the original window, use `side_pocket_resume`. It checks the same owner without replaying uncertain input. An unavailable owner produces a failure, not a saved-copy fallback. Main Pocket sessions and sessions already tracked by another Side Pocket cannot be adopted again.

## Agent tools

The main Pocket uses these tools to manage delegates:

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
| `side_pocket_close`        | Close owned work or detach a live session; cancel queued work                  |
| `side_pocket_resume`       | Reopen the same saved child identity for later messages                        |

Create, send, and adoption retries use an `idempotencyKey`. Repeating an operation with the same key reuses its identity or delivery; different content with that key is rejected.

`side_pocket_send` defaults to `mode: "steer"` for corrections and answers. Conditional Codex steering checks the active turn ID; acceptance does not prove the model consumed the message. Use `mode: "queue"` for a distinct later task. `supersedes` and `side_pocket_cancel` cancel selected unsent assignments while preserving unrelated work and uncertain deliveries.

For a Pocket-owned child, closing waits for process exit and retains history. Resuming makes it ready for another message; its harness starts when work arrives and exits after the turn. Live attachments follow the separate owner behavior above.

Pocket-owned children have `message_parent`, accepting `{ "message": "..." }`. Identical reports in one child turn share a delivery. A question ends that turn; the parent answers with `side_pocket_send` in the same saved session. The host also handles native questions/approvals and supplies a completion report if the child did not message its parent. Scheduling and Side Pocket management tools belong to main conversations.

## Delivery and recovery

State and delivery history live in private `~/.pocket/data/delegations.sqlite`. Preserve it and native harness history across updates; use SQLite backup facilities for a consistent live copy.

Committed changes notify the host through local filesystem events. Startup scans and a 30-second reconciliation pass recover missed notifications. SQLite records and stable message IDs determine what work remains; notifications carry no task payload. A slow report delivery or child shutdown does not block other dispatch or answers. Closing waits for confirmation, with a final state check at its 15-second deadline.

If Pocket stops during a child send, the outcome becomes unknown and the parent receives a recovery report. Inspect saved history before resuming and sending continuation instructions. Uncertain work is not replayed automatically. Pending reports keep their delivery IDs across restarts. Look for `side_pocket.*` events in the [logs](configuration.md#logs-and-private-data).
