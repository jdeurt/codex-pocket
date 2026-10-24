import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const USAGE = "Usage: pocket <update|start|stop|restart> | pocket menubar <setup|remove>";

/** Apply a validated service operation without restarting an already started service.
@param {string} command - Start, stop or restart operation.
@param {(command: string, args: string[]) => { status: number | null }} run - Native process boundary.
@param {string} home - User home directory.
@param {number} userId - Logged-in macOS identity.
@returns {number} Native command status.
*/
function serviceCommand(command, run, home, userId) {
  const domain = `gui/${String(userId)}`;
  const target = `${domain}/dev.pocket.web`;
  const isLoaded = run("/bin/launchctl", ["print", target]).status === 0;

  if ((command === "start" && isLoaded) || (command === "stop" && !isLoaded)) {
    console.info(`Pocket is already ${isLoaded ? "started" : "stopped"}.`);

    return 0;
  }

  if (command === "stop") {
    return run("/bin/launchctl", ["bootout", target]).status ?? 1;
  }

  return (
    run(
      "/bin/launchctl",
      isLoaded
        ? ["kickstart", "-k", target]
        : ["bootstrap", domain, path.join(home, "Library/LaunchAgents/dev.pocket.web.plist")]
    ).status ?? 1
  );
}

/** Execute one public Pocket command against the user's installed service.
@param {string[]} args - Command and optional flags.
@param {(command: string, args: string[]) => { status: number | null, error?: Error }} run - Native process boundary.
@param {string} home - User home directory.
@param {number} userId - Logged-in macOS identity.
@returns {number} Native exit status, or an argument error.
*/
export function pocketCommand(args, run, home, userId) {
  const [command, ...extra] = args;

  if (!command || command === "--help" || command === "help") {
    console.info(USAGE);

    return 0;
  }

  if (command === "menubar" && extra.length === 1 && ["setup", "remove"].includes(extra[0])) {
    return run(process.execPath, [fileURLToPath(new URL("menubar.mjs", import.meta.url)), extra[0]]).status ?? 1;
  }

  if (extra.length > 0 || !["update", "start", "stop", "restart"].includes(command)) {
    console.error(USAGE);

    return 1;
  }

  return command === "update"
    ? (run("/bin/bash", [path.join(home, ".pocket/current/install.sh"), "--update"]).status ?? 1)
    : serviceCommand(command, run, home, userId);
}

/** Run native commands without printing service environment during status probes.
@param {string} command - Absolute native executable.
@param {string[]} args - Command arguments.
@returns {import("node:child_process").SpawnSyncReturns<Buffer>} Native completion.
*/
function execute(command, args) {
  const result = spawnSync(command, args, { stdio: args[0] === "print" ? "ignore" : "inherit" });

  if (result.error) {
    console.error(result.error.message);
  }

  return result;
}

/** Validate the command entry point's platform before using launchd.
@returns {number} Command exit status.
*/
export function main() {
  const userId = process.getuid?.();

  if (userId === undefined || process.platform !== "darwin") {
    console.error("Pocket's service commands require a logged-in macOS user.");

    return 1;
  }

  return pocketCommand(process.argv.slice(2), execute, homedir(), userId);
}
