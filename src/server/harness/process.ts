import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { t } from "try";

const PROCESS_EXIT_TIMEOUT_MS = 5000;

/** Join an owned child and escalate only that process after its grace period.
@param child - Owned process, absent or already exited when no wait is required.
*/
export async function waitForProcessExit(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const timer = setTimeout(child.kill.bind(child, "SIGKILL"), PROCESS_EXIT_TIMEOUT_MS);
  const exited = await t(once(child, "exit"));

  clearTimeout(timer);

  if (!exited.ok) {
    throw exited.error;
  }
}
