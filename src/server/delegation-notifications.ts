import { type FSWatcher, watch, writeFileSync } from "node:fs";
import { log } from "./logging";
import path from "node:path";

const SIGNAL_FILE = "delegations.notify";

// Notifications are hints, never commands. SQLite owns durability and claiming.
// Watch the directory so replacing the signal file cannot detach subscribers.
export class DelegationNotifications {
  private listeners = new Set<() => void>();

  private watcher?: FSWatcher;

  private scheduled = false;

  private closed = false;

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

      try {
        writeFileSync(path.join(this.directory, SIGNAL_FILE), crypto.randomUUID(), { mode: 0o600 });
      } catch (error) {
        log().warn({ error }, "side_pocket.notification_failed");
      }

      this.emit();
    });
  };

  constructor(private directory: string) {}

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    if (!this.watcher) {
      try {
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
      } catch (error) {
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

  close() {
    this.closed = true;
    this.listeners.clear();
    this.watcher?.close();
  }
}
