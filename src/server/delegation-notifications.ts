import { type FSWatcher, watch, writeFileSync } from "node:fs";
import { log } from "./logging";
import path from "node:path";
import { t as attempt } from "try";

const SIGNAL_FILE = "delegations.notify";

// Notifications are hints, never commands. SQLite owns durability and claiming.
// Watch the directory so replacing the signal file cannot detach subscribers.
/**
Publish committed delegation changes as hints while SQLite remains authoritative for work claiming.
*/
export class DelegationNotifications {
  private listeners = new Set<() => void>();

  private watcher?: FSWatcher;

  private scheduled = false;

  private closed = false;

  /**
Coalesce local change hints into one post-transaction microtask before notifying subscribers.
*/
  changed = () => {
    if (this.scheduled || this.closed) {
      return;
    }

    this.scheduled = true;
    // Store APIs and their nested SQLite transactions are synchronous. Publish
    // after the outer transaction commits, including mailbox writes inside it.
    queueMicrotask(() => {
      this.scheduled = false;

      if (this.closed) {
        return;
      }

      const outcome = attempt(() => {
        writeFileSync(path.join(this.directory, SIGNAL_FILE), crypto.randomUUID(), { mode: 0o600 });
      });

      if (!outcome.ok) {
        const error = outcome.error;

        log().warn({ error }, "side_pocket.notification_failed");
      }

      this.emit();
    });
  };

  /**
Bind this private state directory without acquiring a native watcher.
@param directory - Private delegation directory whose signal file communicates committed changes.
*/
  constructor(private directory: string) {}

  /**
Notify currently registered change listeners without treating a hint as a command.
*/
  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
Acquire a native directory watcher while at least one change subscriber exists.
@param listener - Owner callback that rechecks authoritative persisted delegation state.
@returns Cleanup removing this listener and closing the watcher after the final subscriber leaves.
*/
  subscribe(listener: () => void) {
    this.listeners.add(listener);

    if (!this.watcher) {
      const outcome1 = attempt(() => {
        this.watcher = watch(this.directory, { persistent: false }, (_event, filename) => {
          if (!filename || filename === SIGNAL_FILE) {
            this.emit();
          }
        });
        this.watcher.on("error", (error) => {
          log().warn({ error }, "side_pocket.notification_watch_failed");
          this.watcher?.close();
          this.watcher = undefined;
        });
      });

      if (!outcome1.ok) {
        const error = outcome1.error;

        log().warn({ error }, "side_pocket.notification_watch_failed");
      }
    }

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size > 0) {
        return;
      }

      this.watcher?.close();
      this.watcher = undefined;
    };
  }

  /**
Prevent queued hints and release this owner's native watcher and listeners.
*/
  close() {
    this.closed = true;
    this.listeners.clear();
    this.watcher?.close();
  }
}
