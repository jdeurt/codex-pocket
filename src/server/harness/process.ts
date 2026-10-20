import { type ChildProcess } from "node:child_process";

const PROCESS_EXIT_TIMEOUT_MS = 5000;

export async function waitForProcessExit(child: ChildProcess | undefined) {
  if (child?.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const pending: { timer?: NodeJS.Timeout } = {};
    const finish = () => {
      clearTimeout(pending.timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve();
    };

    pending.timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_EXIT_TIMEOUT_MS);
    child.once("exit", finish);
    child.once("error", finish);
  });
}
